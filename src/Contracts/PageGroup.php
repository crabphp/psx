<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

use Crab\Contracts\Http\Middleware;

/**
 * Pages and services that share a path prefix, middleware or both, as a
 * route group does for routes. Each step returns another group.
 */
interface PageGroup
{
    public function prefix(string $prefix): static;

    /**
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function middleware(Middleware|string ...$middleware): static;

    /**
     * @param \Closure(Pages): void $pages Declares the group's pages and services.
     */
    public function group(\Closure $pages): void;
}
