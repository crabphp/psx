<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Http\DecodePolicy;
use Crab\Contracts\Http\Decoding;
use Crab\Contracts\Http\Request;
use Crab\Contracts\Routing\Router;

/**
 * Has the requests of pages read strictly: those to a route a page, a
 * query or an action was given, whoever asks, a browser for a document
 * as much as the page for its data; and any that speaks the protocol. A
 * field said twice, a name that cannot be told apart or a body past its
 * bounds is refused before any middleware reads it. The route is asked
 * of the router, by the names the pages' routes were given, and never
 * guessed from how an address looks: an ordinary route keeps its
 * ordinary reading whatever its path holds.
 *
 * @internal
 */
final readonly class StrictPolicy implements DecodePolicy
{
    public function __construct(
        private Decoding $decoding,
        private Kernel $kernel,
    ) {}

    public function select(Request $request): ?Decoding
    {
        if ($request->hasHeader(Protocol::PROTOCOL)) {
            return $this->decoding;
        }
        if ($this->kernel->names === []) {
            return null;
        }
        $route = $this->kernel->container->get(Router::class)->match(
            $request->getMethod(),
            $request->getUri()->getPath(),
        );
        return $route?->name !== null && isset($this->kernel->names[$route->name]) ? $this->decoding : null;
    }
}
