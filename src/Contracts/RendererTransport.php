<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

/**
 * Asks the JS renderer for a page's HTML, for pages rendered on the
 * server. It is given the page's public envelope and nothing of the
 * request: no cookie, no header, no user. The one thing beside it is
 * the document's Content-Security-Policy nonce, where the application
 * sets one, so that the script React itself writes inline may run.
 */
interface RendererTransport
{
    /**
     * @param array<string, mixed> $envelope The page envelope the browser is given too.
     * @param string|null $nonce The document's nonce, which is in the document it answers with as well.
     * @return string The HTML of the application's root.
     * @throws \RuntimeException When the renderer cannot be reached, refuses, or does not answer within its limits.
     */
    public function render(array $envelope, ?string $nonce = null): string;

    /**
     * Whether the renderer of this release answers.
     */
    public function ready(): bool;
}
