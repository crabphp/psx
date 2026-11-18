<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

use Crab\Contracts\Http\Middleware;

/**
 * A page as it was declared, on which more is said by chaining.
 */
interface PageDeclaration
{
    /**
     * The page's name, by which the TSX builds its address: routes.posts.edit({id: 42}).
     */
    public function name(string $name): static;

    /**
     * Middleware around the whole family: the document and every query and action.
     *
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function middleware(Middleware|string ...$middleware): static;

    /**
     * More middleware around one query or action of this page's own file.
     *
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function operation(string $method, Middleware|string ...$middleware): static;

    /**
     * The layouts around the page, outermost first.
     */
    public function layout(string ...$names): static;

    /**
     * "client", or "server" to render its first HTML with the JS renderer.
     */
    public function rendering(string $mode): static;
}
