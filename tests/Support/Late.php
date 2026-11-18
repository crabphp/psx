<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\Contracts\Http\Errors;
use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Middleware;
use Crab\Contracts\Http\Request;
use Crab\Http\HttpException;
use Psr\Http\Message\ResponseInterface;

/**
 * Middleware that lets the method run and then answers in its place
 * with an error, returned or thrown, as one that checks a response or
 * commits a transaction after it might. With "before" it throws
 * without calling the method at all.
 */
final readonly class Late implements Middleware
{
    public function __construct(
        private string $how,
        private Errors $errors,
    ) {}

    public function handle(Request $request, Handler $next): ResponseInterface
    {
        if ($this->how === 'before') {
            throw new HttpException(403, 'Thrown before the method.');
        }
        $next->handle($request);
        if ($this->how === 'throw') {
            throw new HttpException(409, 'Thrown after the method.');
        }
        return $this->errors->make($request, 422, 'Answered in place of the method.');
    }
}
