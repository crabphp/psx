<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

use Crab\Contracts\Http\Middleware;

/**
 * A service as it was declared, on which more is said by chaining.
 */
interface ServiceDeclaration
{
    /**
     * The service's name, by which the TSX builds its scope: services.people.scope({}).
     */
    public function name(string $name): static;

    /**
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function middleware(Middleware|string ...$middleware): static;

    /**
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function operation(string $method, Middleware|string ...$middleware): static;
}
