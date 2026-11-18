<?php

declare(strict_types=1);

namespace Acceptance;

use Crab\Contracts\Http\Errors;
use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Middleware;
use Crab\Contracts\Http\Request;
use Crab\Http\Response;
use Psr\Http\Message\ResponseInterface;

/**
 * An ordinary Crab guard: lets in a browser with a credential of the
 * revision it has reached, and nobody else. A credential of an earlier
 * revision is refused as none at all.
 */
final readonly class Signed implements Middleware
{
    public const string ACCOUNT = 'acceptance.account';

    public function __construct(
        private Session $session,
        private Errors $errors,
    ) {}

    public function handle(Request $request, Handler $next): ResponseInterface
    {
        $account = $this->session->account($request);
        if ($account !== null) {
            return $next->handle($request->withAttribute(self::ACCOUNT, $account));
        }
        $accepts = $request->getHeaderLine('Accept');
        if ($request->getMethod() === 'GET' && str_contains($accepts, 'text/html')) {
            return Response::redirect('/login', 303);
        }
        return $this->errors->make($request, 401, 'Sign in first.', context: ['login' => '/login']);
    }
}
