<?php

declare(strict_types=1);

namespace Crab\Psx\Commands;

use Crab\Contracts\Config\Config;
use Crab\Contracts\Console\Command;
use Crab\Contracts\Console\Input;
use Crab\Contracts\Console\Output;
use Crab\Contracts\Routing\Actions;
use Crab\Psx\Compiler\Compiler;
use Crab\Psx\Compiler\Families;
use Crab\Psx\Compiler\Source;
use Crab\Psx\PsxException;
use Crab\Psx\Runtime\Kernel;
use Crab\Psx\Runtime\Shell;

/**
 * Builds a release: the pages' PHP, their scripts and styles, and the
 * renderer where a page asks for one, checked together and selected
 * together. Everything is built in a folder of its own; "psx.build" is
 * pointed at it only when all of it is there, so a build that fails
 * leaves the release that was being served.
 *
 *     php cua psx:build
 *     php cua psx:build --no-typecheck
 */
final readonly class PsxBuild implements Command
{
    public function __construct(
        private Kernel $kernel,
    ) {}

    public function description(): string
    {
        return 'Build a release: the PHP and the scripts of the pages together';
    }

    public function handle(Input $input, Output $output): int
    {
        $kernel = $this->kernel;
        $base = $kernel->base;
        $selected = $kernel->path((string) $kernel->config('build'));
        $root = dirname($selected);
        $public = $kernel->container->get(Config::class)->get('server.public');
        if (!is_string($public) || $public === '') {
            $output->error('The built scripts are published into the public folder, and "server.public" names none.');
            return 1;
        }
        $vite = Shell::tool($base, 'vite');
        $tsc = Shell::tool($base, 'tsc');
        if ($vite === null || $tsc === null) {
            $output->error('Vite and TypeScript are not installed. Run `npm ci`; a build installs nothing itself.');
            return 1;
        }
        $stage = "{$root}/stage-" . bin2hex(random_bytes(4));
        try {
            $manifest = $kernel->compiler()->compile($kernel->registry, $stage);
            $families = Families::build(
                $kernel->registry,
                $manifest['modules'],
                $kernel->container->get(Actions::class),
            );
            $output->line(count($manifest['modules']) . ' files compiled.');
            [$status, $said] = Shell::capture(Shell::cua($base, 'psx:verify', "--release={$stage}"), $base);
            if ($status !== 0) {
                throw new PsxException($said === '' ? 'The compiled pages could not be defined.' : $said);
            }
            if (!$input->flag('no-typecheck') && Shell::run([$tsc, '--noEmit', '-p', 'tsconfig.json'], $base) !== 0) {
                throw new PsxException('TypeScript found problems in the TSX.');
            }
            $environment = [
                'PSX_BUILD' => '1',
                'PSX_OUT' => "{$stage}/public",
                'PSX_ASSETS' => rtrim((string) $kernel->config('assets'), '/') . '/',
                'PSX_ENTRY' => (string) $kernel->config('entry'),
                'PSX_RESOURCES' => trim((string) $kernel->config('resources'), '/'),
                'PSX_CLIENT' => trim((string) $kernel->config('client'), '/'),
                'NODE_ENV' => 'production',
            ];
            if (Shell::run([$vite, 'build'], $base, $environment) !== 0) {
                throw new PsxException('Vite could not build the scripts.');
            }
            $built = "{$stage}/public/.vite/manifest.json";
            if (!is_file($built)) {
                throw new PsxException('Vite built no manifest. Keep psx() in vite.config.ts, which asks for one.');
            }
            rename($built, "{$stage}/vite-manifest.json");
            $made = self::inputs($kernel, "{$stage}/public/.vite/psx-inputs.json");
            @rmdir("{$stage}/public/.vite");
            if ($made !== []) {
                throw new PsxException(
                    "The built scripts were made of files that are the server's, which must never be public:\n  "
                        . implode("\n  ", $made),
                );
            }
            $rendered = array_filter(
                $families['routes'],
                static fn(array $route): bool => ($route['rendering'] ?? $kernel->config('rendering')) === 'server',
            );
            if ($rendered !== []) {
                $ssr = [...$environment, 'PSX_SSR' => '1', 'PSX_OUT' => "{$stage}/ssr"];
                if (Shell::run([$vite, 'build', '--ssr'], $base, $ssr) !== 0 || !is_file("{$stage}/ssr/server.mjs")) {
                    throw new PsxException('Vite could not build the renderer.');
                }
                // What the renderer holds reaches a browser as the HTML it writes.
                $made = self::inputs($kernel, "{$stage}/ssr/.vite/psx-inputs.json");
                @rmdir("{$stage}/ssr/.vite");
                if ($made !== []) {
                    throw new PsxException(
                        "The renderer was made of files that are the server's:\n  " . implode("\n  ", $made),
                    );
                }
            }
            $leaks = self::leaks($kernel, $manifest, "{$stage}/public");
            if ($leaks !== []) {
                throw new PsxException(
                    "The built scripts hold PHP of the pages, which must never be public:\n  "
                        . implode("\n  ", $leaks),
                );
            }
            // The release's id is of everything in it: the PHP, the scripts, and the renderer.
            $manifest['build'] = Families::hash([
                $manifest['build'],
                hash_file('sha256', "{$stage}/vite-manifest.json"),
                is_file("{$stage}/ssr/server.mjs") ? hash_file('sha256', "{$stage}/ssr/server.mjs") : null,
            ]);
            Compiler::write(
                "{$stage}/manifest.json",
                json_encode($manifest, JSON_THROW_ON_ERROR | JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n",
            );
            $release = "{$root}/releases/{$manifest['build']}";
            // The scripts go out first and beside the older ones, which pages already open still ask for.
            $assets = rtrim($kernel->path($public), '/') . '/' . trim((string) $kernel->config('assets'), '/');
            self::copy("{$stage}/public", $assets);
            PsxCompile::remove("{$stage}/public");
            if (is_dir($release)) {
                PsxCompile::remove($stage);
            } else {
                if (!is_dir(dirname($release))) {
                    mkdir(dirname($release), 0o755, true);
                }
                rename($stage, $release);
            }
            if (file_exists($selected) && !is_link($selected)) {
                throw new PsxException(
                    "\"psx.build\" is {$selected}, which is a folder of its own and not a link a build can point at a release.",
                );
            }
            $next = "{$selected}." . bin2hex(random_bytes(4));
            symlink('releases/' . $manifest['build'], $next);
            rename($next, $selected);
        } catch (PsxException $refused) {
            PsxCompile::remove($stage);
            $output->error($refused->getMessage());
            $output->error('Nothing was selected: the release being served is the one it was.');
            return 1;
        }
        $output->line("Built release {$manifest['build']}" . ($rendered === [] ? '' : ', with its renderer') . '.');
        $output->line("Selected at {$kernel->config('build')}. `php cua reload` serves it.");
        return 0;
    }

    /**
     * Judges every file the scripts were built from, as Vite's plugin
     * listed them, by where it is and what it is: PHP, the server's
     * settings, and the folders that are the server's are no browser's,
     * whatever a script imported them as. The list is read and removed;
     * a build that wrote none is not published.
     *
     * @return list<string> What is wrong, one line for each file.
     */
    public static function inputs(Kernel $kernel, string $list): array
    {
        $files = is_file($list) ? json_decode((string) file_get_contents($list), true) : null;
        @unlink($list);
        if (!is_array($files)) {
            return [
                'Vite did not say what it built the scripts from. Keep psx() in vite.config.ts, of this version of @crabphp/psx.',
            ];
        }
        $base = rtrim($kernel->base, '/');
        $client = $kernel->path(trim((string) $kernel->config('client'), '/')) . '/client/';
        $storage = $kernel->container->get(\Crab\Contracts\Config\Config::class)->get('app.storage');
        $folders = [
            ...array_map(static fn(string $folder): string => "{$base}/{$folder}", [
                'build',
                'storage',
                'vendor',
                'config',
                'database',
                'app',
                'routes',
            ]),
            dirname($kernel->path((string) $kernel->config('build'))),
            ...(is_string($storage) ? [$storage] : []),
        ];
        $problems = [];
        foreach ($files as $file) {
            if (!is_string($file)) {
                continue;
            }
            $path = str_starts_with($file, '/') ? $file : "{$base}/{$file}";
            if (str_starts_with($path, $client)) {
                // The half of a .psx file the compiler wrote for the browser.
                continue;
            }
            $real = realpath($path);
            foreach (array_unique([$path, $real === false ? $path : $real]) as $judged) {
                $name = basename($judged);
                $why = match (true) {
                    preg_match('/\.(?:psx|php\d?|phtml|phar)$/i', $name) === 1 => 'holds PHP',
                    preg_match('/^\.env(?:\..*)?$/', $name) === 1 => 'holds the settings of the server',
                    default => null,
                };
                foreach ($why === null ? $folders : [] as $folder) {
                    $folder = rtrim($folder, '/');
                    if (!str_starts_with($judged, "{$folder}/")) {
                        continue;
                    }
                    $why = 'is in ' . ltrim(substr($folder, strlen($base)), '/') . "/, which is the server's";
                    break;
                }
                if ($why !== null) {
                    $problems[] = "{$file} {$why}";
                    break;
                }
            }
        }
        return $problems;
    }

    /**
     * Looks through what was built for the browser for the pages' PHP:
     * any line of it long enough to be nobody else's, the opening tag,
     * and the namespace it is compiled into.
     *
     * @param array<string, mixed> $manifest
     * @return list<string>
     */
    public static function leaks(Kernel $kernel, array $manifest, string $public): array
    {
        $needles = [
            '<?php' => 'a PHP opening tag',
            Source::OPEN => 'the opening tag of a PHP block',
            $manifest['namespace'] . '\\' => 'a compiled namespace',
        ];
        // The whole of each file that holds PHP, by its hash: a file given out as it is, is itself.
        $whole = [];
        foreach ($manifest['modules'] as $file => $module) {
            $code = (string) @file_get_contents($kernel->path($file));
            if ($code !== '') {
                $whole[hash('sha256', $code)] = $file;
            }
            if ($module['php'] === null) {
                continue;
            }
            try {
                $region = (string) Source::region($code, $file);
            } catch (PsxException) {
                // Changed since it was compiled so that it no longer splits: look for all of it up to the first end tag.
                $region = substr($code, 0, (int) strpos($code, Source::CLOSE));
            }
            foreach (explode("\n", $region) as $number => $line) {
                $line = trim($line);
                if (
                    strlen($line) >= 28
                    && !str_starts_with($line, 'use ')
                    && !str_starts_with($line, '//')
                    && !str_starts_with($line, '*')
                ) {
                    $needles[$line] = "{$file}:" . ($number + 1);
                }
            }
        }
        $leaks = [];
        if (!is_dir($public)) {
            return [];
        }
        $iterator = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(
            $public,
            \FilesystemIterator::SKIP_DOTS,
        ));
        foreach ($iterator as $built) {
            if (!$built->isFile()) {
                continue;
            }
            $name = substr($built->getPathname(), strlen($public) + 1);
            $content = (string) file_get_contents($built->getPathname());
            $found = self::held($content, $needles, $whole);
            if ($found !== null) {
                $leaks[] = "{$name} holds {$found}";
                continue;
            }
            // What is written in another form is read as what it says: a source map's text, and
            // anything a data URL carries, which is how a file is written into a script.
            foreach (self::decoded($content, str_ends_with($name, '.map')) as $how => $pieces) {
                foreach ($pieces as $piece) {
                    $found = self::held($piece, $needles, $whole);
                    if ($found !== null) {
                        $leaks[] = "{$name} holds {$found}, {$how}";
                        continue 3;
                    }
                }
            }
        }
        return $leaks;
    }

    /**
     * @param array<string, string> $needles
     * @param array<string, string> $whole
     */
    private static function held(string $content, array $needles, array $whole): ?string
    {
        $file = $whole[hash('sha256', $content)] ?? null;
        if ($file !== null) {
            return "the whole of {$file}";
        }
        foreach ($needles as $needle => $what) {
            if (str_contains($content, (string) $needle)) {
                return $what;
            }
        }
        return null;
    }

    /**
     * What a built file carries in another form, decoded.
     *
     * @return array<string, list<string>>
     */
    private static function decoded(string $content, bool $map): array
    {
        $forms = [];
        if ($map) {
            $forms['in its sources'] = [stripcslashes($content)];
            $read = json_decode($content, true);
            if (is_array($read) && is_array($read['sourcesContent'] ?? null)) {
                foreach ($read['sourcesContent'] as $source) {
                    if (is_string($source)) {
                        $forms['in its sources'][] = $source;
                    }
                }
            }
        }
        if (
            preg_match_all('~data:[^,;"\'`\s)]*(?:;[^,;"\'`\s)]+)*;base64,([A-Za-z0-9+/=_-]+)~', $content, $matches) > 0
        ) {
            foreach ($matches[1] as $encoded) {
                $piece = base64_decode(strtr($encoded, '-_', '+/'), true);
                if ($piece !== false && $piece !== '') {
                    $forms['in a data URL'][] = $piece;
                }
            }
        }
        if (preg_match_all('~data:[^,;"\'`\s)]*(?:;[^,;"\'`\s)]+)*,([^"\'`\s)]+)~', $content, $matches) > 0) {
            foreach ($matches[1] as $encoded) {
                $forms['in a data URL'][] = rawurldecode($encoded);
            }
        }
        return $forms;
    }

    private static function copy(string $from, string $to): void
    {
        $iterator = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($from, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::SELF_FIRST,
        );
        if (!is_dir($to)) {
            mkdir($to, 0o755, true);
        }
        foreach ($iterator as $file) {
            $target = $to . substr($file->getPathname(), strlen($from));
            if ($file->isDir()) {
                is_dir($target) || mkdir($target, 0o755, true);
            } else {
                copy($file->getPathname(), $target);
            }
        }
    }
}
