<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * Where a loader, a query or an action sends the page: a path of this
 * application, or another site named deliberately.
 */
final readonly class Redirect
{
    private function __construct(
        public string $href,
        public string $mode,
        public bool $replace,
    ) {}

    /**
     * To a path of this application: "/posts/42?tab=history".
     *
     * @param bool $replace Whether it takes the place of the current history entry.
     */
    public static function to(string $path, bool $replace = false): self
    {
        if (preg_match('~^/(?![/\\\\])[^\x00-\x20\\\\]*$~', $path) !== 1) {
            throw new \InvalidArgumentException(
                "Redirect::to() takes a path of this application, starting with one \"/\", not \"{$path}\". Another site is Redirect::external().",
            );
        }
        return new self($path, 'internal', $replace);
    }

    /**
     * To another site, by a full document navigation.
     */
    public static function external(string $url): self
    {
        if (preg_match('~^https?://[^\s/?#\\\\]+[^\s\\\\]*$~i', $url) !== 1) {
            throw new \InvalidArgumentException("Redirect::external() takes an http(s) address, not \"{$url}\".");
        }
        return new self($url, 'document', false);
    }

    /**
     * To a path of this application by a full document navigation, as
     * after logging in or out.
     */
    public static function document(string $path): self
    {
        return new self(self::to($path)->href, 'document', false);
    }

    /**
     * @return array{href: string, mode: string, replace: bool}
     */
    public function toArray(): array
    {
        return ['href' => $this->href, 'mode' => $this->mode, 'replace' => $this->replace];
    }
}
