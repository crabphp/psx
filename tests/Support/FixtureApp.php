<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\App;
use Crab\AppBuilder;
use Crab\Contracts\Invocation;
use Crab\Psx\PsxPlugin;
use Crab\Psx\Runtime\Kernel;
use Crab\Psx\Testing\PsxTest;

/**
 * An application of .psx files in a folder of its own, compiled and
 * served as a real one is: collected, compiled, then defined against
 * what was compiled.
 */
final class FixtureApp
{
    /**
     * The folders made, removed when the tests end.
     *
     * @var list<string>
     */
    private static array $made = [];

    public readonly string $namespace;
    public ?string $stage = null;

    /**
     * @param string $base The application's folder.
     */
    public function __construct(
        public readonly string $base,
        ?string $namespace = null,
    ) {
        $this->namespace = $namespace ?? 'Psx\\T' . bin2hex(random_bytes(6));
    }

    /**
     * Copies the fixture application and changes or adds these files.
     *
     * @param array<string, string|null> $files By path inside the application; null removes one.
     * @param string|null $namespace The namespace its pages are compiled into; one of its own where none is given.
     */
    public static function copy(array $files = [], ?string $namespace = null): self
    {
        $base = sys_get_temp_dir() . '/psx-fixture-' . bin2hex(random_bytes(6));
        self::$made[] = $base;
        if (count(self::$made) === 1) {
            register_shutdown_function(static function (): void {
                foreach (self::$made as $made) {
                    exec('rm -rf ' . escapeshellarg($made));
                }
            });
        }
        $from = dirname(__DIR__) . '/fixtures/app';
        exec('cp -R ' . escapeshellarg($from) . ' ' . escapeshellarg($base));
        $app = new self($base, $namespace);
        foreach ($files as $path => $content) {
            $app->write($path, $content);
        }
        return $app;
    }

    public function write(string $path, ?string $content): void
    {
        $file = "{$this->base}/{$path}";
        if ($content === null) {
            @unlink($file);
            return;
        }
        is_dir(dirname($file)) || mkdir(dirname($file), 0o755, true);
        file_put_contents($file, $content);
    }

    /**
     * Compiles the application's pages; a mistake in them is thrown.
     *
     * @return array<string, mixed> The private manifest.
     */
    public function compile(): array
    {
        App::invoked(new Invocation('psx:types'));
        try {
            $app = $this->builder(new PsxPlugin(namespace: $this->namespace))->create();
        } finally {
            App::invoked(null);
        }
        $this->stage = "{$this->base}/build/psx/stage-" . bin2hex(random_bytes(4));
        $kernel = $app->container->get(Kernel::class);
        return $kernel->compiler()->compile($kernel->registry, $this->stage);
    }

    /**
     * The application serving what compile() compiled.
     *
     * @param \Closure(AppBuilder): AppBuilder|null $configure
     */
    public function serve(?\Closure $configure = null): PsxTest
    {
        if ($this->stage === null) {
            $this->compile();
        }
        $builder = $this->builder(new PsxPlugin(release: $this->stage, namespace: $this->namespace));
        return PsxTest::of(($configure === null ? $builder : $configure($builder))->create());
    }

    public function read(string $path): string
    {
        return (string) file_get_contents("{$this->base}/{$path}");
    }

    private function builder(PsxPlugin $plugin): AppBuilder
    {
        return App::configure($this->base)->withPlugins([$plugin])->withRouting(routes: 'routes/web.php');
    }
}
