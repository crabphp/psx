<?php

declare(strict_types=1);

namespace Acceptance;

use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Middleware;
use Crab\Contracts\Http\Request;
use Psr\Http\Message\ResponseInterface;

/**
 * A strict Content-Security-Policy for the built application: scripts
 * run by their nonce or from this origin, and nothing inline without
 * it. PSX reads the nonce from the request attribute "csp_nonce".
 * Left out under `php cua dev`, where Vite's own client needs more.
 */
final readonly class Csp implements Middleware
{
    public function handle(Request $request, Handler $next): ResponseInterface
    {
        if (env('ACCEPTANCE_CSP', true) !== true) {
            return $next->handle($request);
        }
        $nonce = rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
        $response = $next->handle($request->withAttribute('csp_nonce', $nonce));
        return $response->withHeader(
            'Content-Security-Policy',
            "default-src 'self'; script-src 'self' 'nonce-{$nonce}'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        );
    }
}
