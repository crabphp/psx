<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

use Crab\Contracts\Http\Middleware;

/**
 * A layout as it was declared, on which more is said by chaining.
 */
interface LayoutDeclaration
{
    /**
     * Middleware around every page in this layout, and their queries and actions.
     *
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function middleware(Middleware|string ...$middleware): static;

    /**
     * More middleware around one query or action of the layout's own file, on every page it is in.
     *
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function operation(string $method, Middleware|string ...$middleware): static;

    /**
     * The path parameters that say which instance of the layout this is:
     * while they stay the same the layout keeps its React state from one
     * page to the next. Without it, those its own file's methods take.
     */
    public function identity(string ...$pathParameters): static;
}
