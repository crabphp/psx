<?php

declare(strict_types=1);

namespace Acceptance;

use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Middleware;
use Crab\Contracts\Http\Request;
use Crab\Http\Cookie;
use Psr\Http\Message\ResponseInterface;

/**
 * Names each browser once, in a cookie it keeps whoever signs in.
 */
final readonly class Browser implements Middleware
{
    public function handle(Request $request, Handler $next): ResponseInterface
    {
        $named = $request->getCookieParams()[Session::CONTEXT] ?? null;
        if (is_string($named) && preg_match('/^[a-f0-9]{32}$/', $named) === 1) {
            return $next->handle($request);
        }
        $name = bin2hex(random_bytes(16));
        return $next
            ->handle($request->withAttribute(Session::ATTRIBUTE, $name))
            ->withAddedHeader('Set-Cookie', (string) new Cookie(Session::CONTEXT, $name, 86_400 * 30));
    }
}
