<?php

declare(strict_types=1);

namespace Crab\Psx\Registry;

use Crab\Contracts\Http\Middleware;
use Crab\Psx\Contracts\PageGroup as PageGroupContract;

/**
 * A group being described: each step returns another, and group()
 * declares its pages.
 *
 * @internal
 */
final readonly class PageGroup implements PageGroupContract
{
    /**
     * @param \Closure(string, list<Middleware|string>, \Closure): void $enter Declares the pages inside the group.
     * @param list<Middleware|string> $middleware
     */
    public function __construct(
        private \Closure $enter,
        private string $prefix = '',
        private array $middleware = [],
    ) {}

    public function prefix(string $prefix): static
    {
        if ($prefix === '' || $prefix[0] !== '/' || str_ends_with($prefix, '/')) {
            throw new \InvalidArgumentException(
                "A group's prefix starts with \"/\" and does not end with one, such as \"/admin\", not \"{$prefix}\".",
            );
        }
        return new self($this->enter, $this->prefix . $prefix, $this->middleware);
    }

    public function middleware(Middleware|string ...$middleware): static
    {
        return new self($this->enter, $this->prefix, [...$this->middleware, ...array_values($middleware)]);
    }

    public function group(\Closure $pages): void
    {
        ($this->enter)($this->prefix, $this->middleware, $pages);
    }
}
