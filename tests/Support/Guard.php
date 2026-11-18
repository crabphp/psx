<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\Contracts\Http\Errors;
use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Middleware;
use Crab\Contracts\Http\Request;
use Psr\Http\Message\ResponseInterface;

/**
 * A guard that lets through a request carrying its pass in X-Pass, and
 * writes down, in order, that it ran.
 */
final class Guard implements Middleware
{
    /**
     * @var list<string>
     */
    public static array $ran = [];

    public function __construct(
        private readonly string $name,
        private readonly Errors $errors,
        private readonly bool $open = false,
        private readonly bool $reads = false,
    ) {}

    public function handle(Request $request, Handler $next): ResponseInterface
    {
        self::$ran[] = $this->name;
        if ($this->reads) {
            // As a middleware that reads the query string before the route's own code does.
            $request->getQueryParams();
        }
        if (!$this->open && !in_array($this->name, explode(',', $request->getHeaderLine('X-Pass')), true)) {
            return $this->errors->make(
                $request,
                401,
                "The guard {$this->name} refused.",
                headers: ['WWW-Authenticate' => 'Pass'],
                context: ['login' => '/login'],
            );
        }
        return $next->handle($request)->withAddedHeader('X-Guarded', $this->name);
    }
}
