<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Request;
use Crab\Psx\ActionResult;
use Crab\Psx\Failure;
use Crab\Psx\PsxException;
use Crab\Psx\QueryData;
use Crab\Psx\Redirect;
use Psr\Http\Message\ResponseInterface;

/**
 * Answers one query or one action at its own address. The request is
 * checked against the protocol, this release and the operation's schema
 * before the method is entered; the method's arguments are bound by
 * Crab as any action's are.
 *
 * @internal
 */
final readonly class OperationHandler implements Handler
{
    /**
     * @param array<string, mixed> $operation As Families expanded it.
     */
    public function __construct(
        private array $operation,
        private Responder $responder,
        private WireCodec $codec,
    ) {}

    public function handle(Request $request): ResponseInterface
    {
        $operation = $this->operation;
        $action = $operation['role'] === 'action';
        $refused =
            $this->responder->preflight($request, $operation['schema'])
            ?? ($action ? $this->media($request) : null)
            ?? $this->responder->readable($request, body: $action)
            ?? ($operation['auth'] ? $this->revision($request) : null);
        if ($refused !== null) {
            return $refused;
        }
        $outcome = $operation['prepared']->invoke($request);
        // Past the guards and held to the revision it saw, a refusal of an action that changes who is
        // signed in says who is signed in as it says it: the page can then tell it from a guard's
        // refusal, which proves nothing of its credentials. Not a 401: that one is about them.
        $witnessed = $operation['auth'] ? ['witnessed' => true] : [];
        if (!$outcome->entered) {
            return $witnessed === [] || $outcome->problem?->status !== 422
                ? $outcome->rejection
                : $this->responder->unbound($request, $outcome->problem, $witnessed);
        }
        $value = $outcome->value;
        $where = "{$operation['file']}: {$operation['method']}()";
        if (!$action) {
            if ($value instanceof Redirect) {
                return $this->responder->redirect($request, $value, 'entered');
            }
            if ($value instanceof Failure) {
                return $this->responder->failed($request, $value);
            }
            $tags = [];
            if ($value instanceof QueryData) {
                $tags = $value->tags;
                $value = $value->data;
            }
            return $this->responder->data(
                $request,
                [
                    'kind' => 'query',
                    'data' => $this->codec->encode($operation['shape'], $value, $where),
                    'tags' => $tags,
                ],
                $operation['schema'],
            );
        }
        $result = $value instanceof ActionResult ? $value : ActionResult::ok($value);
        if ($result->authChanged && !$operation['auth']) {
            // The method ran: this is no refusal, and what it changed is not known to have been undone.
            throw new PsxException(
                "{$operation['method']}() answered authChanged() and is not an #[Action(auth: true)]. Only an action declared so is held to the revision of who is signed in before it runs, and has the page wait while it does. Declare it #[Action(auth: true)] and name the application's AuthState in \"psx.auth_state\"; nothing was told to the page, and no cookie of this answer was sent.",
                $operation['file'],
                $operation['line'],
            );
        }
        if ($result->failure !== null) {
            $response = $this->responder->failed($request, $result->failure, $witnessed);
        } else {
            $response = $this->responder->data(
                $request,
                [
                    'kind' => 'action',
                    'ok' => true,
                    'data' => $this->codec->encode($operation['shape'], $result->data, $where),
                    'invalidate' => $result->invalidate,
                    'authChanged' => $result->authChanged,
                    ...($result->redirect === null ? [] : ['redirect' => $result->redirect->toArray()]),
                ],
                $operation['schema'],
            );
        }
        foreach ($result->cookies as $cookie) {
            $response = $response->withAddedHeader('Set-Cookie', (string) $cookie);
        }
        return $response;
    }

    /**
     * An action's body is JSON, or a form where its schema can be one;
     * files come by a form alone.
     */
    private function media(Request $request): ?ResponseInterface
    {
        $type = strtolower(trim(explode(';', $request->getHeaderLine('Content-Type'))[0]));
        $allowed = $this->operation['files'] ? ['multipart/form-data'] : ['application/json', 'multipart/form-data'];
        if (in_array($type, $allowed, true)) {
            return null;
        }
        return $this->responder->refuse(
            $request,
            415,
            'unsupported_media_type',
            'This action takes ' . implode(' or ', $allowed) . '.',
        );
    }

    /**
     * An action that changes who the browser is signed in as says which
     * revision of that it saw; one that is no longer current is refused
     * before it is entered.
     */
    private function revision(Request $request): ?ResponseInterface
    {
        $seen = $request->getHeaderLine(Protocol::REVISION);
        $current = $this->responder->services->auth()?->snapshot($request)->revision;
        if ($current === null || $seen === $current) {
            return null;
        }
        return $this->responder->refuse(
            $request,
            409,
            'auth_transition',
            'Who is signed in changed since this page was loaded.',
        );
    }
}
