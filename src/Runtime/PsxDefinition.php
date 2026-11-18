<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Definition;
use Crab\Contracts\Http\Errors;
use Crab\Contracts\Http\Factory;
use Crab\Contracts\Http\Handler;
use Crab\Contracts\Routing\Actions;
use Crab\Contracts\Routing\DeclaredRoute;
use Crab\Contracts\Routing\Router;
use Crab\Contracts\Servers;
use Crab\Psx\Compiler\Addresses;
use Crab\Psx\Compiler\Families;
use Crab\Psx\Contracts\AuthState;
use Crab\Psx\Contracts\DocumentRenderer;
use Crab\Psx\Contracts\RendererTransport;
use Crab\Psx\PsxException;

/**
 * Finishes what the pages files declared, once the plugins and the
 * route files have all run: the declarations are sealed, and where a
 * release is served its routes are added to the application's router,
 * one for each page and each query and action, behind the middleware
 * their declarations gave.
 *
 * @internal
 */
final class PsxDefinition implements Definition
{
    /**
     * The application's services a worker makes for the pages, each with where it is named.
     *
     * @var array<string, string>
     */
    private array $named = [];

    public function __construct(
        private readonly Kernel $kernel,
    ) {}

    public function name(): string
    {
        return 'psx';
    }

    public function finish(): void
    {
        $kernel = $this->kernel;
        if ($kernel->mode === Kernel::COLLECT || $kernel->mode === Kernel::ABSENT) {
            $kernel->registry->seal();
            return;
        }
        $container = $kernel->container;
        $manifest = Kernel::manifest((string) $kernel->release);
        foreach ($manifest['modules'] as $file => $module) {
            if ($module['php'] !== null && !class_exists((string) $module['class'], false)) {
                // The module's own folder is all that is loaded: a manifest names no other path.
                if (
                    preg_match('~^php/[A-Za-z0-9_./-]+\.php$~', $module['php']) !== 1
                    || str_contains($module['php'], '..')
                ) {
                    throw new PsxException('The release names a file outside itself.', $file);
                }
                require_once "{$kernel->release}/{$module['php']}";
            }
        }
        $families = Families::build($kernel->registry, $manifest['modules'], $container->get(Actions::class));
        if (Families::fingerprint($families) !== $manifest['fingerprint']) {
            throw new PsxException(
                'The pages declared are not the ones the release was built from: a page, a layout, a guard or a method changed since. Build again with `php cua psx:build`.',
            );
        }
        $kernel->registry->seal();
        $settings = $kernel->settings($manifest);
        // Nothing of the application's is made here: this is the process that declares, and what
        // answers requests is made in each worker, by the first request that needs it.
        $authClass = $kernel->config('auth_state');
        if (is_string($authClass) && !is_a($authClass, AuthState::class, true)) {
            throw new PsxException("\"psx.auth_state\" is {$authClass}, which is not an " . AuthState::class . '.');
        }
        $rendered = array_filter(
            $families['routes'],
            static fn(array $route): bool => ($route['rendering'] ?? $settings->rendering) === 'server',
        );
        $socket = $rendered === [] || $container->has(RendererTransport::class) ? null : $this->renderer($settings);
        $services = new Services(
            is_string($authClass) ? static fn(): AuthState => $container->get($authClass) : null,
            static fn(): DocumentRenderer => $container->has(DocumentRenderer::class)
                ? $container->get(DocumentRenderer::class)
                : new HtmlRenderer(),
            match (true) {
                $rendered === [] => null,
                $socket === null => static fn(): RendererTransport => $container->get(RendererTransport::class),
                default => $socket,
            },
        );
        $this->named = [
            ...(is_string($authClass) ? [$authClass => '"psx.auth_state"'] : []),
            ...($container->has(DocumentRenderer::class) ? [DocumentRenderer::class => 'The pages\' documents'] : []),
            ...(
                $rendered !== [] && $socket === null
                    ? [RendererTransport::class => 'The pages rendered on the server']
                    : []
            ),
        ];
        $responder = new Responder(
            $container->get(Factory::class),
            $container->get(Errors::class),
            $settings,
            $services,
        );
        $codec = new WireCodec((int) $kernel->config('max_depth'), (int) $kernel->config('max_collection_items'));
        $assets = new Assets($settings);
        $assets->check();
        $router = $container->get(Router::class);
        foreach ($families['routes'] as $name => $route) {
            $declared = self::add(
                $router,
                'GET',
                $route['path'],
                new PageHandler($route, $responder, $codec, $container->get(Factory::class), $assets),
                $name,
                $route['file'],
            );
            $kernel->names[$name] = 'page';
            if ($route['middleware'] !== []) {
                $declared->middleware(...$route['middleware']);
            }
            $this->operations($router, $route['operations'], $responder, $codec);
        }
        foreach ($families['services'] as $service) {
            $this->operations($router, $service['operations'], $responder, $codec);
        }
        $kernel->families = $families;
        $kernel->responder = $responder;
    }

    public function entries(): array
    {
        // What a worker makes for the pages, checked as the routes' own entries are: by reading, making nothing.
        $entries = $this->named;
        foreach ($this->kernel->families['routes'] ?? [] as $name => $route) {
            foreach ($route['nodes'] as $node) {
                if ($node['class'] !== null) {
                    $entries[$node['class']] = "Page {$name} ({$node['declaration']->file})";
                }
            }
        }
        foreach ($this->kernel->families['services'] ?? [] as $name => $service) {
            foreach ($service['operations'] as $operation) {
                foreach ($operation['prepared']->dependencies() as $class) {
                    $entries[$class] = "Service {$name} ({$service['file']})";
                }
            }
        }
        return $entries;
    }

    public function describe(): array
    {
        $lines = [];
        foreach ($this->kernel->registry->layouts() as $layout) {
            $lines[] = "layout {$layout->name} {$layout->file}";
        }
        foreach ($this->kernel->registry->pages() as $page) {
            $lines[] =
                "page {$page->name} {$page->path} {$page->file}"
                . ($page->layouts === [] ? '' : ' in ' . implode(' > ', $page->layouts));
        }
        foreach ($this->kernel->registry->services() as $service) {
            $lines[] = "service {$service->name} {$service->path} {$service->file}";
        }
        foreach ([
            ...($this->kernel->families['routes'] ?? []),
            ...($this->kernel->families['services'] ?? []),
        ] as $family) {
            foreach ($family['operations'] as $operation) {
                $lines[] =
                    "{$operation['role']} {$operation['name']} "
                    . ($operation['role'] === 'query' ? 'GET' : 'POST')
                    . " {$operation['pattern']}";
            }
        }
        return $lines;
    }

    /**
     * @param array<string, array<string, mixed>> $operations
     */
    private function operations(Router $router, array $operations, Responder $responder, WireCodec $codec): void
    {
        foreach ($operations as $operation) {
            if ($operation['auth'] && !$responder->services->identifies()) {
                throw new PsxException(
                    "{$operation['method']}() is an #[Action(auth: true)], which changes who the browser is signed in as, and \"psx.auth_state\" names no "
                    . AuthState::class
                    . ' to tell one sign-in from the next.',
                    $operation['file'],
                    $operation['line'],
                );
            }
            $declared = self::add(
                $router,
                $operation['role'] === 'query' ? 'GET' : 'POST',
                $operation['pattern'],
                new OperationHandler($operation, $responder, $codec),
                $operation['name'],
                $operation['file'],
            );
            if ($operation['middleware'] !== []) {
                $declared->middleware(...$operation['middleware']);
            }
            $this->kernel->names[$operation['name']] = 'operation';
        }
    }

    /**
     * Adds a route of a page's; one the application's own routes
     * already have is the page's mistake, said with its file.
     */
    private static function add(
        Router $router,
        string $method,
        string $pattern,
        Handler $handler,
        string $name,
        string $file,
    ): DeclaredRoute {
        if ($handler instanceof OperationHandler && str_contains($pattern, '{')) {
            // A route with a parameter is answered by the first declared that fits. One declared
            // before this that may fit its address would answer in its place, for some page or for
            // all: that is refused unless the two are proven apart. Nothing of the router changes.
            foreach ($router->routes() as $route) {
                if (
                    $route->method !== $method
                    || !str_contains($route->pattern, '{')
                    || !Addresses::shadows($route->pattern, $pattern)
                ) {
                    continue;
                }
                $whose = $route->name === null ? $route->action : "\"{$route->name}\"";
                throw new PsxException(
                    "{$method} {$pattern}, which {$name} is asked at, may be answered by the route {$method} {$route->pattern} ({$whose}) declared before it: the router answers with the first route that fits, and it is not proven that this one does not. Give that route a first segment of its own, or its parameters an expression of letters, digits, \"_\", \".\" and \"-\" alone, such as {name:[A-Za-z0-9_.-]+}, which is seen not to take \"_psx\" or a \"/\"; or declare it after the pages.",
                    $file,
                );
            }
        }
        try {
            return $router->add($method, $pattern, $handler)->name($name);
        } catch (\LogicException|\InvalidArgumentException $refused) {
            throw new PsxException(
                "{$refused->getMessage()} A page's address and its name are its own: an ordinary route cannot have them too.",
                $file,
                previous: $refused,
            );
        }
    }

    /**
     * The renderer of this release, and the process that runs it where
     * the application supervises it.
     */
    private function renderer(Settings $settings): \Closure
    {
        $kernel = $this->kernel;
        $socket = $kernel->socket($settings->build);
        $public = $kernel->container->get(\Crab\Contracts\Config\Config::class)->get('server.public');
        if (
            is_string($public)
            && $public !== ''
            && str_starts_with($socket, rtrim($kernel->path($public), '/') . '/')
        ) {
            throw new PsxException("\"psx.ssr.socket\" is {$socket}, inside the public folder. Keep it in storage.");
        }
        $timeout = (float) $kernel->config('ssr.timeout_seconds');
        if ($kernel->mode === Kernel::SERVE && $kernel->config('ssr.supervise') === true) {
            $bundle = "{$settings->release}/ssr/server.mjs";
            if (!is_file($bundle)) {
                throw new PsxException(
                    "A page is rendered on the server, and the release {$settings->release} has no renderer. `php cua psx:build` builds it when a page asks for it.",
                );
            }
            // The renderer is of this server process and stops with it. A server that takes over
            // from another runs beside it for a while, each with a renderer of its own, of the same
            // release as often as not: each listens at an address that is its own alone, so that
            // one stopping takes nothing from under the other.
            $socket = self::own($socket, (string) $kernel->config('ssr.socket'));
            $kernel->supervised = $socket;
            $kernel->container->get(Servers::class)->process('psx-ssr', implode(' ', array_map(escapeshellarg(...), [
                (string) $kernel->config('ssr.node'),
                '--max-old-space-size=' . (int) $kernel->config('ssr.memory_mb'),
                $bundle,
                "--socket={$socket}",
                "--build={$settings->build}",
                '--max-request-bytes=' . (int) $kernel->config('ssr.max_request_bytes'),
                '--max-html-bytes=' . (int) $kernel->config('ssr.max_html_bytes'),
                '--max-inflight=' . (int) $kernel->config('ssr.max_inflight'),
                '--max-queue=' . (int) $kernel->config('ssr.max_queue'),
                "--timeout-seconds={$timeout}",
            ])));
        }
        $limits = [
            (int) $kernel->config('ssr.max_request_bytes'),
            (int) $kernel->config('ssr.max_html_bytes'),
            (int) $kernel->config('ssr.max_inflight'),
        ];
        return static fn(): RendererTransport => new SocketRenderer($socket, $settings->build, $timeout, ...$limits);
    }

    /**
     * The address of the renderer this process runs: the release's, with
     * this process's number before its ending. What a server process that
     * was killed left at such an address is taken away here; one that
     * stops as it should takes its own.
     *
     * @param string $named "psx.ssr.socket" as it is written, which says what such an address looks like.
     */
    private static function own(string $socket, string $named): string
    {
        $ending = str_ends_with($socket, '.sock') ? '.sock' : '';
        $stem = substr($socket, 0, strlen($socket) - strlen($ending));
        $name = basename($named);
        $name = substr($name, 0, strlen($name) - strlen($ending));
        // Only what this setting names: nothing else that lies in the folder is looked at.
        $like =
            '~^'
            . str_replace('\{build\}', '[0-9a-f]+', preg_quote($name, '~'))
            . '\.([1-9][0-9]*)'
            . preg_quote($ending, '~')
            . '$~D';
        $folder = dirname($socket);
        foreach (function_exists('posix_kill') && is_dir($folder) ? (scandir($folder) ?: []) : [] as $left) {
            $found = [];
            if (
                preg_match($like, $left, $found) === 1
                && (int) $found[1] !== getmypid()
                && !posix_kill((int) $found[1], 0)
                && posix_get_last_error() === 3
                && @filetype("{$folder}/{$left}") === 'socket'
            ) {
                @unlink("{$folder}/{$left}");
            }
        }
        return "{$stem}." . getmypid() . $ending;
    }
}
