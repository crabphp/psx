<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Http\HttpException;
use Crab\Psx\PsxException;

/**
 * The scripts and styles a document names: in development those of
 * Vite's server, read from where it says it listens; otherwise those of
 * the release's own build, read once.
 *
 * @internal
 */
final class Assets
{
    /**
     * @var array{scripts: list<string>, styles: list<string>, preloads: list<string>}|null
     */
    private ?array $built = null;

    public function __construct(
        private readonly Settings $settings,
    ) {}

    /**
     * @return array{scripts: list<string>, styles: list<string>, preloads: list<string>, preamble: string|null}
     */
    public function document(): array
    {
        if ($this->settings->development) {
            $origin = is_file($this->settings->hot) ? trim((string) file_get_contents($this->settings->hot)) : '';
            if (preg_match('~^https?://[A-Za-z0-9.\[\]:-]+$~', $origin) !== 1) {
                throw new HttpException(503, 'Vite is not running yet. `php cua dev` starts it beside the server.');
            }
            return [
                'scripts' => ["{$origin}/@vite/client", "{$origin}/{$this->settings->entry}"],
                'styles' => [],
                'preloads' => [],
                'preamble' =>
                    "import { injectIntoGlobalHook } from \"{$origin}/@react-refresh\";\n"
                        . "injectIntoGlobalHook(window);\nwindow.\$RefreshReg\$ = () => {};\nwindow.\$RefreshSig\$ = () => (type) => type;\n",
            ];
        }
        return [...($this->built ??= $this->built()), 'preamble' => null];
    }

    /**
     * Whether the release has what a document needs; a serving
     * application is refused without it.
     */
    public function check(): void
    {
        if (!$this->settings->development) {
            $this->built ??= $this->built();
        }
    }

    /**
     * @return array{scripts: list<string>, styles: list<string>, preloads: list<string>}
     */
    private function built(): array
    {
        $path = "{$this->settings->release}/vite-manifest.json";
        $manifest = is_file($path) ? json_decode((string) file_get_contents($path), true) : null;
        $entry = is_array($manifest) ? $manifest[$this->settings->entry] ?? null : null;
        if (!is_array($manifest) && $this->settings->staged) {
            // A release being checked or tested, before its scripts are built: a document names none.
            return ['scripts' => [], 'styles' => [], 'preloads' => []];
        }
        if (!is_array($entry) || !isset($entry['file'])) {
            throw new PsxException(
                "The release {$this->settings->release} has no built script for {$this->settings->entry}. `php cua psx:build` builds the PHP and the scripts of a release together.",
            );
        }
        $base = $this->settings->assets;
        $styles = [];
        $preloads = [];
        $seen = [];
        $walk = static function (array $chunk) use (&$walk, &$styles, &$preloads, &$seen, $manifest, $base): void {
            foreach ($chunk['css'] ?? [] as $style) {
                $styles[$base . $style] = true;
            }
            foreach ($chunk['imports'] ?? [] as $import) {
                if (isset($seen[$import]) || !isset($manifest[$import]['file'])) {
                    continue;
                }
                $seen[$import] = true;
                $preloads[$base . $manifest[$import]['file']] = true;
                $walk($manifest[$import]);
            }
        };
        $walk($entry);
        return [
            'scripts' => [$base . $entry['file']],
            'styles' => array_keys($styles),
            'preloads' => array_keys($preloads),
        ];
    }
}
