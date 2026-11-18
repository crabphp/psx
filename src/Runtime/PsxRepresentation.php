<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Http\Problem;
use Crab\Contracts\Http\Representation;
use Crab\Contracts\Http\Request;
use Crab\Contracts\Routing\Router;
use Psr\Http\Message\ResponseInterface;

/**
 * Writes an error as the protocol's problem envelope for a request that
 * is a page's own, wherever the error came from: a guard, the router,
 * the binder or the method. A request is a page's own when it speaks
 * the protocol, when the refusal is one the pages made, or when its
 * route is a query's or an action's. Every other request keeps the
 * application's own errors, a browser asking for a document among them.
 *
 * @internal
 */
final readonly class PsxRepresentation implements Representation
{
    public function __construct(
        private Kernel $kernel,
    ) {}

    public function render(Problem $problem, Request $request): ?ResponseInterface
    {
        $responder = $this->kernel->responder;
        if ($responder === null) {
            return null;
        }
        if (
            !Protocol::spoken($request)
            && !isset($problem->context[Protocol::CONTEXT])
            && !$this->operation($request)
        ) {
            return null;
        }
        return $responder->problem($request, $problem);
    }

    /**
     * Whether the request's route is a query's or an action's, as the router has it.
     */
    private function operation(Request $request): bool
    {
        $route = $this->kernel->container->get(Router::class)->match(
            $request->getMethod(),
            $request->getUri()->getPath(),
        );
        return $route?->name !== null && ($this->kernel->names[$route->name] ?? null) === 'operation';
    }
}
