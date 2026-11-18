<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Middleware;
use Crab\Contracts\Http\Request;
use Psr\Http\Message\ResponseInterface;

/**
 * Around every route: a request that says it is a page's own, by the
 * protocol's headers or its media type, is held to the protocol and to
 * this release before any route is looked for. A page of an older
 * release, or of another protocol, is refused here whatever its address
 * now leads to, an ordinary route or a fallback included, so that
 * nothing it asks for is entered. Which schema it was compiled against
 * is its route's to check, once the route is known. A request that says
 * nothing of the protocol passes untouched.
 *
 * @internal
 */
final readonly class Preflight implements Middleware
{
    /**
     * @param \Closure(): ?Responder $responder The responder, once the application is defined.
     */
    public function __construct(
        private \Closure $responder,
    ) {}

    public function handle(Request $request, Handler $next): ResponseInterface
    {
        if (
            !$request->hasHeader(Protocol::PROTOCOL)
            && !$request->hasHeader(Protocol::BUILD)
            && !$request->hasHeader(Protocol::SCHEMA)
            && !Protocol::spoken($request)
        ) {
            return $next->handle($request);
        }
        return ($this->responder)()?->release($request) ?? $next->handle($request);
    }
}
