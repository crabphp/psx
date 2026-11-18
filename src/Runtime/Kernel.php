<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Config\Config;
use Crab\Contracts\Container\Container;
use Crab\Contracts\Routing\Actions;
use Crab\Psx\Compiler\Compiler;
use Crab\Psx\Compiler\Source;
use Crab\Psx\PsxException;
use Crab\Psx\Registry\Registry;

/**
 * What the plugin, its definition and its commands share: the open
 * registry, how this process was asked to treat it, and where things are.
 *
 * @internal
 */
final class Kernel
{
    /**
     * Only declarations are collected: nothing compiled is loaded and no route is added.
     */
    public const string COLLECT = 'collect';

    /**
     * A release is served: the one "psx.build" selects, or the one given.
     */
    public const string SERVE = 'serve';

    /**
     * A release not yet selected is served, to check it or to test against
     * it: it may have no built scripts yet.
     */
    public const string STAGED = 'staged';

    /**
     * The release `php cua dev` last compiled is served, with Vite beside it.
     */
    public const string DEVELOPMENT = 'development';

    /**
     * No release is selected and none is needed: a console command that serves nothing.
     */
    public const string ABSENT = 'absent';

    public ?Responder $responder = null;

    /**
     * The routes the pages were given, by name: "page" for a page's own
     * address, "operation" for a query's or an action's. Empty until the
     * application is defined.
     *
     * @var array<string, 'page'|'operation'>
     */
    public array $names = [];

    /**
     * What was expanded from the declarations and the release, once defined.
     *
     * @var array{routes: array<string, array<string, mixed>>, services: array<string, array<string, mixed>>}|null
     */
    public ?array $families = null;

    /**
     * Where the renderer this application runs itself listens; null where
     * it runs none.
     */
    public ?string $supervised = null;

    /**
     * @param string $mode One of the constants above.
     * @param string|null $release The release's folder where the mode serves one, absolute.
     */
    public function __construct(
        public readonly Container $container,
        public readonly Registry $registry,
        public readonly string $base,
        public string $mode,
        public ?string $release,
        public readonly string $namespace = Source::ROOT,
    ) {}

    public function config(string $key): mixed
    {
        return $this->container->get(Config::class)->get("psx.{$key}");
    }

    /**
     * A path of the application, absolute.
     */
    public function path(string $relative): string
    {
        return str_starts_with($relative, '/') ? $relative : "{$this->base}/{$relative}";
    }

    /**
     * Where `php cua dev` compiles into.
     */
    public function developmentRoot(): string
    {
        return dirname($this->path((string) $this->config('build'))) . '/dev';
    }

    public function compiler(): Compiler
    {
        $wrapper = $this->config('wrapper');
        return new Compiler(
            $this->base,
            trim((string) $this->config('resources'), '/'),
            trim((string) $this->config('client'), '/'),
            $this->container->get(Actions::class),
            $this->namespace,
            is_string($wrapper) ? $wrapper : null,
        );
    }

    /**
     * A release's private manifest.
     *
     * @return array<string, mixed>
     */
    public static function manifest(string $release): array
    {
        $path = "{$release}/manifest.json";
        $manifest = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        if (!is_array($manifest) || !isset($manifest['build'], $manifest['modules'], $manifest['fingerprint'])) {
            throw new PsxException(
                "There is no release at {$release}. `php cua psx:build` builds one for \"psx.build\", and `php cua dev` compiles as you work.",
            );
        }
        if (($manifest['protocol'] ?? null) !== Protocol::VERSION) {
            throw new PsxException(
                "The release at {$release} was built for another protocol. Build it again with `php cua psx:build`.",
            );
        }
        return $manifest;
    }

    /**
     * @param array<string, mixed> $manifest
     */
    public function settings(array $manifest): Settings
    {
        $assets = (string) $this->config('assets');
        return new Settings(
            build: (string) $manifest['build'],
            base: $this->base,
            release: (string) $this->release,
            assets: rtrim($assets, '/') . '/',
            entry: (string) $this->config('entry'),
            rendering: (string) $this->config('rendering'),
            development: $this->mode === self::DEVELOPMENT,
            hot: $this->path(trim((string) $this->config('client'), '/') . '/hot'),
            maxResponseBytes: (int) $this->config('max_response_bytes'),
            limits: [
                'queryCacheEntries' => (int) $this->config('query_cache_entries'),
                'queryCacheBytes' => (int) $this->config('query_cache_bytes'),
                'queryCacheGcSeconds' => (int) $this->config('query_cache_gc_seconds'),
                'prefetchTtlSeconds' => (int) $this->config('prefetch_ttl_seconds'),
                'readRetries' => (int) $this->config('read_retries'),
                'authReconcileSeconds' => (int) $this->config('auth_reconcile_seconds'),
                'maxResponseBytes' => (int) $this->config('max_response_bytes'),
                'maxDepth' => (int) $this->config('max_depth'),
            ],
            lang: (string) $this->config('lang'),
            staged: $this->mode === self::STAGED,
        );
    }

    /**
     * Where the renderer of a release listens.
     */
    public function socket(string $build): string
    {
        $socket = str_replace(
            '{build}',
            $this->mode === self::DEVELOPMENT ? 'dev' : $build,
            (string) $this->config('ssr.socket'),
        );
        if (str_starts_with($socket, 'storage/')) {
            $storage = $this->container->get(Config::class)->get('app.storage');
            return (is_string($storage) ? $storage : "{$this->base}/storage") . substr($socket, strlen('storage'));
        }
        return $this->path($socket);
    }
}
