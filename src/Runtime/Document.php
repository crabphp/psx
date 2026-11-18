<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Psx\Head;

/**
 * A document ready to be written: everything in it was decided before
 * the renderer is asked, which runs no loader and reads no request.
 */
final readonly class Document
{
    /**
     * @param string $bootstrap What the page starts from, as JSON safe inside a script element.
     * @param list<string> $scripts The addresses of its module scripts, in order.
     * @param list<string> $styles The addresses of its stylesheets.
     * @param list<string> $preloads The addresses of the modules to load early.
     * @param string|null $preamble A module script's own text, which development's refresh needs first.
     * @param string|null $html The page as React rendered it on the server; null where the browser renders it.
     * @param string|null $nonce The request's Content-Security-Policy nonce, where the application sets one.
     */
    public function __construct(
        public int $status,
        public string $lang,
        public Head $head,
        public string $bootstrap,
        public array $scripts,
        public array $styles = [],
        public array $preloads = [],
        public ?string $preamble = null,
        public ?string $html = null,
        public ?string $nonce = null,
    ) {}
}
