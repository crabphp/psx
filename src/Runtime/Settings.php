<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

/**
 * What a release is served with: read once when the application is
 * defined, and the same for every request of the process.
 *
 * @internal
 */
final readonly class Settings
{
    /**
     * @param string $build The release's id.
     * @param string $base The application's folder.
     * @param string $release The release's private folder, resolved once.
     * @param string $assets The public address its scripts and styles are under: "/assets/psx/".
     * @param string $entry The browser's entry, relative to the application.
     * @param string $rendering "client" or "server", where a page says nothing.
     * @param bool $development Whether `php cua dev` serves it, with Vite beside.
     * @param string $hot The file Vite's development server writes its address in.
     * @param array<string, int> $limits What the page's runtime is bounded by.
     * @param string $lang The document's language.
     * @param bool $staged Whether the release is one being checked or tested, which may have no built scripts.
     */
    public function __construct(
        public string $build,
        public string $base,
        public string $release,
        public string $assets,
        public string $entry,
        public string $rendering,
        public bool $development,
        public string $hot,
        public int $maxResponseBytes,
        public array $limits,
        public string $lang = 'en',
        public bool $staged = false,
    ) {}
}
