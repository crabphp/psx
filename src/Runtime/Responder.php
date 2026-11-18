<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Http\Errors;
use Crab\Contracts\Http\Factory;
use Crab\Contracts\Http\HttpError;
use Crab\Contracts\Http\Problem;
use Crab\Contracts\Http\Request;
use Crab\Contracts\Routing\Entered;
use Crab\Psx\Failure;
use Crab\Psx\Redirect;
use Psr\Http\Message\ResponseInterface;

/**
 * Writes the protocol's responses: the envelope of a page, a query or an
 * action's data, which belongs to this release alone, and the control
 * envelopes, a problem or a redirect, which any release's page can read.
 *
 * @internal
 */
final readonly class Responder
{
    private const array HTML = ['text/html' => 3, 'text/*' => 2, '*/*' => 1];

    private const array CODES = [
        400 => 'bad_request',
        401 => 'unauthenticated',
        403 => 'forbidden',
        404 => 'not_found',
        405 => 'method_not_allowed',
        406 => 'not_acceptable',
        408 => 'timeout',
        409 => 'conflict',
        413 => 'payload_too_large',
        415 => 'unsupported_media_type',
        422 => 'validation',
        429 => 'rate_limited',
        503 => 'unavailable',
    ];

    public function __construct(
        private Factory $factory,
        private Errors $errors,
        public Settings $settings,
        public Services $services,
    ) {}

    /**
     * What a request that speaks the protocol must say whatever its
     * address is: the protocol, and this release. Null when it does.
     * It is asked before a route is looked for, see Preflight.
     */
    public function release(Request $request): ?ResponseInterface
    {
        $protocol = $request->getHeaderLine(Protocol::PROTOCOL);
        if ($protocol === '') {
            return $this->refuse($request, 400, 'protocol', 'The ' . Protocol::PROTOCOL . ' header is missing.');
        }
        if ($protocol !== (string) Protocol::VERSION) {
            return $this->refuse(
                $request,
                400,
                'unsupported_protocol',
                'This server speaks protocol ' . Protocol::VERSION . '.',
            );
        }
        if ($request->getHeaderLine(Protocol::BUILD) !== $this->settings->build) {
            return $this->refuse($request, 409, 'build_mismatch', 'The application was updated. Reload the page.');
        }
        return null;
    }

    /**
     * What a request must say before a loader, a query or an action is
     * entered: the protocol, this release, and the schema it was
     * compiled against. Null when it does.
     *
     * @param bool $required Whether the request must speak the protocol; a page's address answers a document too.
     */
    public function preflight(Request $request, string $schema, bool $required = true): ?ResponseInterface
    {
        if ($required && !Protocol::accepted($request)) {
            return $this->refuse($request, 406, 'not_acceptable', 'This address answers ' . Protocol::MEDIA . ' only.');
        }
        $refused = $this->release($request);
        if ($refused !== null) {
            return $refused;
        }
        if ($request->getHeaderLine(Protocol::SCHEMA) !== $schema) {
            return $this->refuse($request, 409, 'build_mismatch', 'The application was updated. Reload the page.');
        }
        return null;
    }

    /**
     * Whether a browser asking for a document takes HTML in answer; null
     * when it does, and otherwise the application's own 406, written
     * before any loader runs. No Accept at all takes anything.
     */
    public function html(Request $request): ?ResponseInterface
    {
        if (!$request->hasHeader('Accept') || Protocol::quality($request, self::HTML) > 0.0) {
            return null;
        }
        return $this->errors->make($request, 406, 'This address answers text/html.');
    }

    /**
     * Reads the query string and the body now, so that one that cannot
     * be read is refused before the method is entered, and is not taken
     * for a failure inside it. Null when both can be read.
     */
    public function readable(Request $request, bool $body, bool $document = false): ?ResponseInterface
    {
        try {
            $request->getQueryParams();
            if ($body) {
                $request->getParsedBody();
                $request->getUploadedFiles();
            }
        } catch (HttpError $error) {
            if ($document) {
                // A browser's own request: the application's own error, as for any of its routes.
                return $this->errors->make($request, $error->status, $error->getMessage());
            }
            return $this->refuse(
                $request,
                $error->status,
                self::CODES[$error->status] ?? 'bad_request',
                $error->getMessage(),
            );
        }
        return null;
    }

    /**
     * A refusal before the method was entered.
     *
     * @param array<string, mixed> $context
     */
    public function refuse(
        Request $request,
        int $status,
        string $code,
        string $message,
        array $context = [],
    ): ResponseInterface {
        return $this->errors->make($request, $status, $message, context: [
            Protocol::CONTEXT => ['code' => $code, 'execution' => 'not-entered', 'expected' => true, ...$context],
        ]);
    }

    /**
     * Input that did not bind, as the router refused it, with what PSX adds to it.
     *
     * @param array<string, mixed> $context
     */
    public function unbound(Request $request, Problem $problem, array $context): ResponseInterface
    {
        return $this->errors->make(
            $request,
            $problem->status,
            $problem->message,
            fields: $problem->fields,
            query: $problem->query,
            path: $problem->path,
            context: [
                ...$problem->context,
                Protocol::CONTEXT => ['execution' => 'not-entered', 'expected' => true, ...$context],
            ],
        );
    }

    /**
     * A failure the method returned.
     *
     * @param array<string, mixed> $context
     */
    public function failed(Request $request, Failure $failure, array $context = []): ResponseInterface
    {
        return $this->errors->make($request, $failure->status, $failure->message, fields: $failure->fields, context: [
            // Returned by the method: it says itself that nothing it did was kept.
            Protocol::CONTEXT => ['code' => $failure->code, 'execution' => 'entered', 'expected' => true, ...$context],
        ]);
    }

    /**
     * The data of a page, a query or an action, for this release's page alone.
     *
     * @param array<string, mixed> $envelope
     */
    public function data(Request $request, array $envelope, string $schema): ResponseInterface
    {
        $requestId = $request->getAttribute('request_id');
        return $this->json([
            'protocol' => Protocol::VERSION,
            'build' => $this->settings->build,
            ...$envelope,
            ...(is_string($requestId) ? ['requestId' => $requestId] : []),
            ...$this->snapshot($request),
        ], 200)->withHeader(Protocol::SCHEMA, $schema);
    }

    /**
     * Where to go instead, said in the protocol: a request of the page's
     * own is never answered with a redirect its fetch would follow.
     */
    public function redirect(Request $request, Redirect $redirect, string $execution): ResponseInterface
    {
        return $this->json($this->control($request, 'redirect', $execution) + ['target' => $redirect->toArray()], 200);
    }

    /**
     * A problem as the protocol says it.
     */
    public function problem(Request $request, Problem $problem): ResponseInterface
    {
        $context = (array) ($problem->context[Protocol::CONTEXT] ?? []);
        $status = $problem->status;
        $code = $context['code'] ?? self::CODES[$status] ?? ($status >= 500 ? 'server_error' : 'refused');
        $message = $problem->message;
        // An address this release does not have, asked for by another release's page: it was removed or renamed.
        $requested = $request->getHeaderLine(Protocol::BUILD);
        if (
            in_array($status, [404, 405], true)
            && !isset($context['code'])
            && $requested !== ''
            && $requested !== $this->settings->build
        ) {
            $status = 409;
            $code = 'build_mismatch';
            $message = 'The application was updated. Reload the page.';
        }
        // Whether the method was entered is what the router recorded for this request, never a guess
        // from the status or from whether something was thrown. A problem PSX made itself says so
        // in its context; any other, a middleware's or an exception's, is after the method only if
        // the method was called. Without the record nothing is known, and nothing safe is claimed.
        $record = $request->getAttribute(Entered::ATTRIBUTE);
        $execution =
            $context['execution'] ?? ($record instanceof Entered && !$record->entered() ? 'not-entered' : 'entered');
        // Expected is what PSX wrote on purpose: a refusal before the method, or a Failure the method
        // returned. Anything else that follows the method's entry promises nothing of what it did.
        $expected = ($context['expected'] ?? false) === true || $execution === 'not-entered';
        $requestId = $request->getAttribute('request_id');
        $login = $problem->context['login'] ?? null;
        $public = [
            'status' => $status,
            'code' => $code,
            'message' => $message,
            'fields' => (object) $problem->fields,
            'query' => (object) $problem->query,
            'path' => (object) $problem->path,
            ...(is_string($requestId) ? ['requestId' => $requestId] : []),
            ...(is_string($login) ? ['loginUrl' => $login] : []),
        ];
        $envelope = $this->control($request, 'problem', $execution) + ['expected' => $expected, 'problem' => $public];
        if ($expected && ($context['witnessed'] ?? false) === true) {
            // Read now, after whatever the method did: a page that knows another revision is not told
            // that nothing changed.
            $envelope += $this->snapshot($request);
        }
        if (isset($context['page'])) {
            // The loaders that ran before the one that failed, for this release's page alone.
            $envelope['pageError'] = $context['page'];
        }
        return $this->json($envelope, $status);
    }

    /**
     * The public problem of a document that could not be loaded.
     *
     * @return array<string, mixed>
     */
    public function documented(Request $request, Problem $problem): array
    {
        return (array) json_decode(
            (string) $this->problem($request, $problem)->getBody(),
            false,
            flags: JSON_THROW_ON_ERROR,
        );
    }

    /**
     * @return array<string, mixed>
     */
    public function snapshot(Request $request): array
    {
        $auth = $this->services->auth();
        return $auth === null ? [] : ['auth' => $auth->snapshot($request)->toArray()];
    }

    /**
     * @return array<string, mixed>
     */
    private function control(Request $request, string $kind, string $execution): array
    {
        $requested = $request->getHeaderLine(Protocol::BUILD);
        return [
            'protocol' => Protocol::VERSION,
            'kind' => $kind,
            'respondingBuild' => $this->settings->build,
            'requestedBuild' => $requested === '' ? null : substr($requested, 0, 64),
            'execution' => $execution,
        ];
    }

    /**
     * @param array<string, mixed> $envelope
     */
    private function json(array $envelope, int $status): ResponseInterface
    {
        $body = json_encode(
            $envelope,
            JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION,
        );
        if (strlen($body) > $this->settings->maxResponseBytes) {
            throw new WireException(
                'The response is '
                . strlen($body)
                . " bytes, over the {$this->settings->maxResponseBytes} of \"psx.max_response_bytes\". Send less, or a page of it.",
            );
        }
        return $this->factory
            ->createResponse($status)
            ->withHeader('Content-Type', Protocol::MEDIA)
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('Vary', 'Accept')
            ->withHeader(Protocol::PROTOCOL, (string) Protocol::VERSION)
            ->withHeader(Protocol::BUILD, $this->settings->build)
            ->withBody($this->factory->createStream($body));
    }
}
