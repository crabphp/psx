<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Http\Factory;
use Crab\Contracts\Http\Handler;
use Crab\Contracts\Http\Problem;
use Crab\Contracts\Http\Request;
use Crab\Psx\Failure;
use Crab\Psx\Head;
use Crab\Psx\PageData;
use Crab\Psx\Redirect;
use Crab\Psx\Tags;
use Psr\Http\Message\ResponseInterface;

/**
 * Answers a page's address: the document for a browser that asks for
 * one, the page's envelope for the page's own navigation. Both run the
 * same loaders, the layouts' outer first and then the page's, behind
 * the same middleware, and stop at the first that redirects or fails.
 *
 * @internal
 */
final readonly class PageHandler implements Handler
{
    /**
     * @param array<string, mixed> $route The page's family, as Families expanded it.
     */
    public function __construct(
        private array $route,
        private Responder $responder,
        private WireCodec $codec,
        private Factory $factory,
        private Assets $assets,
    ) {}

    public function handle(Request $request): ResponseInterface
    {
        $navigation = Protocol::spoken($request);
        // Both are read the one strict way, and refused before a loader runs: the page in the protocol,
        // a browser by the application's own errors.
        $refused = $navigation
            ? $this->responder->preflight($request, $this->route['navigation']) ?? $this->responder->readable(
                $request,
                body: false,
            )
            : $this->responder->html($request) ?? $this->responder->readable($request, body: false, document: true);
        if ($refused !== null) {
            return $refused;
        }
        $nodes = [];
        $head = Head::none();
        $tags = [];
        $parameters = [];
        foreach (array_column($this->route['segments'], 'name') as $name) {
            $parameters[$name] = (string) $request->getAttribute($name);
        }
        $path = $request->getUri()->getPath();
        foreach ($this->route['nodes'] as $node) {
            $data = null;
            if ($node['load'] !== null) {
                $outcome = $node['load']->invoke($request, $node['projection']);
                if (!$outcome->entered) {
                    return $this->failed(
                        $request,
                        $navigation,
                        $outcome->problem,
                        'not-entered',
                        $nodes,
                        $head,
                        $tags,
                        $outcome->rejection,
                    );
                }
                $value = $outcome->value;
                if ($value instanceof Redirect) {
                    return $navigation
                        ? $this->responder->redirect($request, $value, 'entered')
                        : $this->factory
                            ->createResponse(303)
                            ->withHeader('Location', $value->href)
                            ->withHeader('Cache-Control', 'private, no-store');
                }
                if ($value instanceof Failure) {
                    $problem = new Problem($value->status, $value->message, $value->fields, context: [
                        Protocol::CONTEXT => ['code' => $value->code],
                    ]);
                    return $this->failed($request, $navigation, $problem, 'entered', $nodes, $head, $tags, null);
                }
                if ($value instanceof PageData) {
                    $head = $value->head->over($head);
                    $tags = Tags::merge($tags, $value->tags);
                    $value = $value->data;
                }
                $data = $this->codec->encode($node['shape'], $value, "{$node['declaration']->file}: load()");
            }
            $identity = array_map(static fn(string $name): string => $parameters[$name], $node['identity']);
            $nodes[] = [
                'mount' => $node['mount'],
                'module' => $node['module'],
                'key' =>
                    ($node['layout'] ?? $this->route['name'])
                        . ':'
                        . implode('/', array_map(rawurlencode(...), $identity)),
                'data' => $data,
                'scope' => [
                    'routeId' => $this->route['name'],
                    'mountId' => $node['mount'],
                    'href' => $path,
                    'params' => (object) $parameters,
                ],
            ];
        }
        $envelope = ['kind' => 'page', ...$this->page($request, $nodes, $head, $tags)];
        if ($navigation) {
            return $this->responder->data($request, $envelope, $this->route['navigation']);
        }
        // Read back as objects: an empty map stays {} and an empty list [], as the browser was promised.
        $complete = (array) json_decode(
            (string) $this->responder->data($request, $envelope, $this->route['navigation'])->getBody(),
            false,
            flags: JSON_THROW_ON_ERROR,
        );
        $rendering = $this->route['rendering'] ?? $this->responder->settings->rendering;
        $nonce = $request->getAttribute('csp_nonce');
        $html = $rendering === 'server'
            ? $this->responder->services->transport()?->render($complete, is_string($nonce) ? $nonce : null)
            : null;
        return $this->document($request, 200, $complete, $head, $html);
    }

    /**
     * The page's part of an envelope: its route, and the loaders' data in order.
     *
     * @param list<array<string, mixed>> $nodes
     * @param list<string> $tags
     * @return array<string, mixed>
     */
    private function page(Request $request, array $nodes, Head $head, array $tags): array
    {
        $query = $request->getUri()->getQuery();
        return [
            'route' => [
                'id' => $this->route['name'],
                'href' => $request->getUri()->getPath() . ($query === '' ? '' : "?{$query}"),
            ],
            'nodes' => $nodes,
            'head' => [
                'title' => $head->toArray()['title'],
                'meta' => (object) $head->toArray()['meta'],
                'links' => (object) $head->toArray()['links'],
            ],
            'tags' => $tags,
        ];
    }

    /**
     * A loader refused or failed: the problem, with what the loaders
     * before it gave, and nothing of it or of those after it.
     *
     * @param list<array<string, mixed>> $nodes
     * @param list<string> $tags
     */
    private function failed(
        Request $request,
        bool $navigation,
        ?Problem $problem,
        string $execution,
        array $nodes,
        Head $head,
        array $tags,
        ?ResponseInterface $rejection,
    ): ResponseInterface {
        $problem ??= new Problem(500, 'The page could not be loaded.');
        $page = [
            'build' => $this->responder->settings->build,
            ...$this->page($request, $nodes, $head, $tags),
            // What the loaders before it gave is someone's: it says whose, as a whole page does. A
            // refusal that carries nothing of anyone asks nothing of the application's AuthState.
            ...($nodes === [] ? [] : $this->responder->snapshot($request)),
        ];
        $context = [...$problem->context];
        $context[Protocol::CONTEXT] = [
            ...((array) ($context[Protocol::CONTEXT] ?? [])),
            'execution' => $execution,
            // Either the binder refused the loader, or the loader returned a Failure: PSX says which.
            'expected' => true,
            'page' => $page,
        ];
        $problem = new Problem(
            $problem->status,
            $problem->message,
            $problem->fields,
            $problem->query,
            $problem->path,
            context: $context,
        );
        if ($navigation) {
            $response = $this->responder->problem($request, $problem);
        } else {
            $response = $this->document(
                $request,
                $problem->status,
                $this->responder->documented($request, $problem),
                $head,
                null,
            );
        }
        // What the refusal carried, such as WWW-Authenticate, stays on what is sent.
        foreach ($rejection?->getHeaders() ?? [] as $name => $values) {
            if (
                !$response->hasHeader($name) && !in_array(strtolower($name), ['content-type', 'content-length'], true)
            ) {
                $response = $response->withHeader($name, $values);
            }
        }
        return $response;
    }

    /**
     * @param array<string, mixed> $envelope The page's envelope, or the problem's.
     */
    private function document(
        Request $request,
        int $status,
        array $envelope,
        Head $head,
        ?string $html,
    ): ResponseInterface {
        $settings = $this->responder->settings;
        $assets = $this->assets->document();
        $nonce = $request->getAttribute('csp_nonce');
        $bootstrap = json_encode(
            [
                'envelope' => $envelope,
                'rendering' => $html === null ? 'client' : 'server',
                'limits' => $settings->limits,
                'development' => $settings->development,
            ],
            // Nothing in it can end the script element it is written in, or start markup.
            JSON_THROW_ON_ERROR
            | JSON_HEX_TAG
            | JSON_HEX_AMP
            | JSON_HEX_APOS
            | JSON_HEX_QUOT
            | JSON_PRESERVE_ZERO_FRACTION,
        );
        $document = new Document(
            $status,
            $settings->lang,
            $head,
            $bootstrap,
            $assets['scripts'],
            $assets['styles'],
            $assets['preloads'],
            $assets['preamble'],
            $html,
            is_string($nonce) ? $nonce : null,
        );
        return $this->factory
            ->createResponse($status)
            ->withHeader('Content-Type', 'text/html; charset=utf-8')
            ->withHeader('Cache-Control', 'private, no-store')
            ->withHeader('Vary', 'Accept')
            ->withBody($this->factory->createStream($this->responder->services->renderer()->render($document)));
    }
}
