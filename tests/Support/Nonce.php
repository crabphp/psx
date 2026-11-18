<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Middleware;
use Crab\Contracts\Http\Request;
use Psr\Http\Message\ResponseInterface;

/**
 * As an application's Content-Security-Policy middleware does: names
 * the document's nonce in the request attribute "csp_nonce". The test
 * says what it is in X-Nonce.
 */
final class Nonce implements Middleware
{
    public function handle(Request $request, Handler $next): ResponseInterface
    {
        $nonce = $request->getHeaderLine('X-Nonce');
        return $next->handle($nonce === '' ? $request : $request->withAttribute('csp_nonce', $nonce));
    }
}
