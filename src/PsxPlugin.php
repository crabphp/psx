<?php

declare(strict_types=1);

namespace Crab\Psx;

use Crab\Contracts\Config\Config;
use Crab\Contracts\Console\Console;
use Crab\Contracts\Container\Container;
use Crab\Contracts\Definitions;
use Crab\Contracts\Development;
use Crab\Contracts\Http\DecodePolicies;
use Crab\Contracts\Http\Decoding;
use Crab\Contracts\Http\MiddlewareStack;
use Crab\Contracts\Http\Representations;
use Crab\Contracts\Invocation;
use Crab\Contracts\WorkerPlugin;
use Crab\Engine\Process\Worker;
use Crab\Psx\Commands\PsxBuild;
use Crab\Psx\Commands\PsxCheck;
use Crab\Psx\Commands\PsxCompile;
use Crab\Psx\Commands\PsxInit;
use Crab\Psx\Commands\PsxList;
use Crab\Psx\Commands\PsxTypes;
use Crab\Psx\Commands\PsxVerify;
use Crab\Psx\Compiler\Source;
use Crab\Psx\Contracts\Pages;
use Crab\Psx\Registry\Registry;
use Crab\Psx\Runtime\DevelopmentSteps;
use Crab\Psx\Runtime\Kernel;
use Crab\Psx\Runtime\Preflight;
use Crab\Psx\Runtime\PsxDefinition;
use Crab\Psx\Runtime\PsxRepresentation;
use Crab\Psx\Runtime\SocketRenderer;
use Crab\Psx\Runtime\StrictPolicy;

/**
 * Pages written as .psx files: PHP that loads and changes, above the
 * React that shows it. Listed in app.php with the files that declare
 * the pages:
 *
 *     new PsxPlugin(routes: ['routes/pages.php'])
 *
 * Each file returns a closure given the Pages registry. Without routes:,
 * routes/pages.php is read if it is there, and the application's own
 * route files may declare pages beside their routes with Psx::page(). Nothing is
 * found by where a file lies: a page, a layout or a service exists
 * because it is declared. The plugin authenticates nobody and starts
 * no session; those stay the application's own middleware.
 */
final readonly class PsxPlugin implements WorkerPlugin
{
    /**
     * The commands that read the declarations and nothing compiled.
     */
    private const array COLLECTING = [
        'psx:init',
        'psx:check',
        'psx:types',
        'psx:build',
        'psx:compile',
        'psx:list',
        'dev',
    ];

    /**
     * The commands that serve, and so need the release "psx.build" selects.
     */
    private const array SERVING = ['start', 'reload', 'restart'];

    /**
     * The longest a worker that answers requests waits for the renderer
     * the application runs beside it, in seconds, before its start has
     * failed: well inside the time a worker is given to start.
     */
    private const float RENDERER_SECONDS = 5.0;

    /**
     * @param list<string>|null $routes The files that declare the pages, relative to the application. Unset, the
     *     pages are declared with Psx::page() in the application's route files, and in routes/pages.php if there is one.
     * @param string|null $release A release to serve in place of the one "psx.build" selects: a test's, compiled for it.
     * @param string|null $namespace The namespace a test's release was compiled into.
     */
    public function __construct(
        private ?array $routes = null,
        private ?string $release = null,
        private ?string $namespace = null,
    ) {}

    public function register(Container $container): void
    {
        $config = $container->get(Config::class);
        self::defaults($config);
        $config->check('psx');
        $base = $config->get('app.path');
        if (!is_string($base)) {
            throw new PsxException(
                'PsxPlugin needs the application\'s folder: build the application with App::configure(__DIR__).',
            );
        }
        $invocation = $container->get(Invocation::class);
        $registry = new Registry($base, $container, (string) $config->get('psx.resources'));
        $kernel = new Kernel($container, $registry, $base, Kernel::SERVE, null, $this->namespace ?? Source::ROOT);
        [$kernel->mode, $kernel->release] = $this->mode($invocation, $kernel);
        $container->instance(Kernel::class, $kernel);
        $container->instance(Pages::class, $registry);
        $routes = $this->routes ?? (is_file("{$base}/routes/pages.php") ? ['routes/pages.php'] : []);
        foreach ($routes as $file) {
            if ($invocation->command === 'psx:init') {
                // The scaffold declares nothing: it may be about to write this very file.
                continue;
            }
            if (!is_file("{$base}/{$file}")) {
                throw new PsxException(
                    'PsxPlugin is given a pages file that is not there. `php cua psx:init` writes a first one.',
                    $file,
                );
            }
            $declare = require "{$base}/{$file}";
            if (!$declare instanceof \Closure) {
                throw new PsxException(
                    'PsxPlugin is given a file that returns a closure taking the Pages registry: return static function (Pages $pages): void { ... };',
                    $file,
                );
            }
            $declare($registry);
        }
        $container->get(Definitions::class)->add(new PsxDefinition($kernel));
        $container->get(Representations::class)->add(new PsxRepresentation($kernel));
        $container->get(DecodePolicies::class)->add(
            new StrictPolicy(
                new Decoding(
                    maxDepth: (int) $config->get('psx.max_depth'),
                    maxNodes: (int) $config->get('psx.max_input_nodes'),
                    maxNameBytes: (int) $config->get('psx.max_field_name_bytes'),
                    maxItems: (int) $config->get('psx.max_collection_items'),
                ),
                $kernel,
            ),
        );
        // Before any route is looked for: a page of another release enters nothing, whatever its address leads to now.
        $container->get(MiddlewareStack::class)->add(new Preflight(static fn() => $kernel->responder));
        $console = $container->get(Console::class);
        $console->add('psx:init', PsxInit::class, 'Write a first page, its layout and what builds them');
        $console->add('psx:check', PsxCheck::class, 'Check the pages, their types and their declarations');
        $console->add('psx:build', PsxBuild::class, 'Build a release: the PHP and the scripts of the pages together');
        $console->add('psx:list', PsxList::class, 'List the pages, their layouts, queries and actions');
        $console->add('psx:types', PsxTypes::class, 'Write the types and bindings the TSX is checked against');
        $console->add('psx:compile', PsxCompile::class);
        $console->add('psx:verify', PsxVerify::class);
        if ($invocation->command === 'dev') {
            DevelopmentSteps::register($container->get(Development::class), $kernel);
        }
    }

    /**
     * A worker that answers requests starts once the renderer the server
     * runs beside it listens, and stays connected to it. A server that
     * has just started, or is taking over from another, is not ready
     * until then: it renders its first page instead of refusing it, and
     * one whose renderer does not come never takes the place of a server
     * that works. The worker does not start without it; the server starts
     * it again, as it does any worker that could not start.
     */
    public function start(Worker $worker, Container $container): void
    {
        $renderer = $this->renderer($worker, $container);
        if ($renderer === null) {
            return;
        }
        $deadline = microtime(true) + self::RENDERER_SECONDS;
        while (!$renderer->hold(min(0.25, max(0.0, $deadline - microtime(true))))) {
            if (microtime(true) >= $deadline) {
                throw new PsxException(
                    'A page is rendered on the server, and the renderer did not listen within '
                    . (int) self::RENDERER_SECONDS
                    . ' seconds. The server is not ready without it: see what "psx.ssr.node" runs, and what the renderer wrote.',
                );
            }
            usleep(25_000);
        }
    }

    /**
     * The worker has finished what it had: the renderer is let go of, and
     * stops once the last worker of its server has.
     */
    public function stop(Worker $worker, Container $container): void
    {
        $this->renderer($worker, $container)?->release();
    }

    /**
     * The renderer of a worker that answers requests, where the server runs one itself.
     */
    private function renderer(Worker $worker, Container $container): ?SocketRenderer
    {
        $kernel = $container->get(Kernel::class);
        if ($kernel->supervised === null || $worker->group->listeners() === []) {
            return null;
        }
        $renderer = $kernel->responder?->services->transport();
        return $renderer instanceof SocketRenderer ? $renderer : null;
    }

    /**
     * How this process treats the pages, from what the console was
     * asked to do: never from a request, and never by guessing from a
     * release that happens to be missing.
     *
     * @return array{string, string|null}
     */
    private function mode(Invocation $invocation, Kernel $kernel): array
    {
        if ($this->release !== null) {
            return [Kernel::STAGED, $this->release];
        }
        if ($invocation->command === 'psx:verify') {
            $release = $invocation->option('release');
            if ($release === null) {
                throw new PsxException('psx:verify is given the release to check: --release=build/psx/stage.');
            }
            return [Kernel::STAGED, $kernel->path($release)];
        }
        if (in_array($invocation->command, self::COLLECTING, true)) {
            return [Kernel::COLLECT, null];
        }
        if ($invocation->development) {
            $current = realpath($kernel->developmentRoot() . '/current');
            if ($current === false) {
                throw new PsxException('`php cua dev` has compiled nothing to serve yet.');
            }
            return [Kernel::DEVELOPMENT, $current];
        }
        // Resolved once: a release selected while this process runs is the next process's.
        $selected = realpath($kernel->path((string) $kernel->config('build')));
        if ($selected === false) {
            if ($invocation->command === null || in_array($invocation->command, self::SERVING, true)) {
                throw new PsxException(
                    'There is no release at "psx.build", '
                    . $kernel->config('build')
                    . '. Build one with `php cua psx:build`; to work on the pages, run `php cua dev`.',
                );
            }
            return [Kernel::ABSENT, null];
        }
        return [Kernel::SERVE, $selected];
    }

    private static function defaults(Config $config): void
    {
        $positive = ['type' => 'integer', 'minimum' => 1];
        $path = ['type' => 'string', 'minLength' => 1];
        $config->defaults(
            'psx',
            [
                'resources' => 'resources',
                'client' => '.psx',
                'build' => 'build/psx/current',
                'assets' => '/assets/psx/',
                'entry' => 'resources/entry.tsx',
                'wrapper' => null,
                'auth_state' => null,
                'rendering' => 'client',
                'lang' => 'en',
                'max_response_bytes' => 2_097_152,
                'max_depth' => 32,
                'max_collection_items' => 10_000,
                'max_input_nodes' => 20_000,
                'max_field_name_bytes' => 256,
                'auth_reconcile_seconds' => 5,
                'query_cache_entries' => 200,
                'query_cache_bytes' => 8_388_608,
                'query_cache_gc_seconds' => 300,
                'prefetch_ttl_seconds' => 15,
                'read_retries' => 0,
                'ssr' => [
                    'supervise' => true,
                    'socket' => 'storage/psx/ssr-{build}.sock',
                    'node' => 'node',
                    'memory_mb' => 256,
                    'max_request_bytes' => 3_145_728,
                    'timeout_seconds' => 5,
                    'max_html_bytes' => 4_194_304,
                    'max_inflight' => 16,
                    'max_queue' => 32,
                ],
            ],
            [
                'resources' => [...$path, 'description' => 'The folder of the .psx files, private to the server.'],
                'client' => [
                    ...$path,
                    'description' => 'Where the TSX, types and bindings the JavaScript build reads are written.',
                ],
                'build' => [...$path, 'description' => 'The release that is served, often a link to it.'],
                'assets' => [
                    'type' => 'string',
                    'pattern' => '^/.*/$',
                    'description' => 'The public address of the built scripts and styles.',
                ],
                'entry' => $path,
                'wrapper' => ['type' => ['string', 'null'], 'minLength' => 1],
                'auth_state' => ['type' => ['string', 'null'], 'minLength' => 1],
                'rendering' => ['enum' => ['client', 'server']],
                'lang' => ['type' => 'string', 'pattern' => '^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$'],
                'max_response_bytes' => $positive,
                'max_depth' => $positive,
                'max_collection_items' => $positive,
                'max_input_nodes' => $positive,
                'max_field_name_bytes' => $positive,
                'auth_reconcile_seconds' => $positive,
                'query_cache_entries' => $positive,
                'query_cache_bytes' => $positive,
                'query_cache_gc_seconds' => $positive,
                'prefetch_ttl_seconds' => $positive,
                'read_retries' => ['type' => 'integer', 'minimum' => 0, 'maximum' => 2],
                'ssr' => [
                    'type' => 'object',
                    'additionalProperties' => false,
                    'properties' => [
                        'supervise' => ['type' => 'boolean'],
                        'socket' => $path,
                        'node' => $path,
                        'memory_mb' => $positive,
                        'max_request_bytes' => $positive,
                        'timeout_seconds' => $positive,
                        'max_html_bytes' => $positive,
                        'max_inflight' => $positive,
                        'max_queue' => $positive,
                    ],
                ],
            ],
        );
    }
}
