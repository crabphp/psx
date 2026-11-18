<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Psx\Contracts\AuthState;
use Crab\Psx\Contracts\DocumentRenderer;
use Crab\Psx\Contracts\RendererTransport;

/**
 * The application's services the pages are answered with: who a browser
 * is, what writes a document, what renders one on the server. A
 * definition only says how each is made; each is made by the first
 * request that needs it, which is a worker's, so that none is made in
 * the process that declares the routes and copied into its workers.
 *
 * @internal
 */
final class Services
{
    private ?AuthState $auth = null;
    private ?DocumentRenderer $renderer = null;
    private ?RendererTransport $transport = null;

    /**
     * @param (\Closure(): AuthState)|null $makeAuth Null where the application names no AuthState.
     * @param \Closure(): DocumentRenderer $makeRenderer
     * @param (\Closure(): RendererTransport)|null $makeTransport Null where no page is rendered on the server.
     */
    public function __construct(
        private readonly ?\Closure $makeAuth,
        private readonly \Closure $makeRenderer,
        private readonly ?\Closure $makeTransport,
    ) {}

    /**
     * Whether the application tells one sign-in from the next; nothing is made to say so.
     */
    public function identifies(): bool
    {
        return $this->makeAuth !== null;
    }

    public function auth(): ?AuthState
    {
        return $this->makeAuth === null ? null : ($this->auth ??= ($this->makeAuth)());
    }

    public function renderer(): DocumentRenderer
    {
        return $this->renderer ??= ($this->makeRenderer)();
    }

    public function transport(): ?RendererTransport
    {
        return $this->makeTransport === null ? null : ($this->transport ??= ($this->makeTransport)());
    }
}
