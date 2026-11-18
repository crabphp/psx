<?php

declare(strict_types=1);

namespace Crab\Psx\Testing;

use Crab\App;
use Crab\Contracts\Http\Handler;
use Crab\Contracts\Invocation;
use Crab\Http\Request;
use Crab\Psx\PsxException;
use Crab\Psx\Runtime\Kernel;
use Crab\Psx\Runtime\Protocol;
use Crab\Psx\Runtime\Shell;
use Psr\Container\ContainerInterface;
use Psr\Http\Message\UploadedFileInterface;

/**
 * Asks an application for its pages as a browser would, through the
 * application's own handling: its middleware, its router, its binder.
 * Nothing is called around them.
 *
 *     $psx = PsxTest::boot(__DIR__ . '/..');
 *     $psx->navigate('/posts/7')->assertOk();
 *     $psx->action('posts.edit', 'savePost', ['id' => 7], ['title' => 'New', 'version' => 3]);
 *
 * A query or an action is named as it was declared: the page's or the
 * service's name, and the method. A layout's is named with the layout:
 * "posts.edit/app".
 */
final class PsxTest
{
    /**
     * @var array<string, string>
     */
    private array $headers = [];

    public function __construct(
        public readonly Handler $app,
        private readonly Kernel $kernel,
    ) {
        if ($kernel->families === null) {
            throw new PsxException(
                'The application serves no release here: PsxTest::boot() compiles one and serves it.',
            );
        }
    }

    /**
     * Compiles the application's pages as `php cua dev` does, and gives
     * the application serving what was compiled.
     *
     * @param string $base The application's folder, where app.php and cua are.
     */
    public static function boot(string $base): self
    {
        $base = rtrim($base, '/');
        [$status, $said] = Shell::capture(Shell::cua($base, 'psx:compile'), $base);
        if ($status !== 0) {
            throw new PsxException("The pages could not be compiled: {$said}");
        }
        $release = null;
        App::invoked(new Invocation('psx:types'));
        try {
            $collecting = require "{$base}/app.php";
            $release = $collecting->container->get(Kernel::class)->developmentRoot() . '/current';
        } finally {
            App::invoked(null);
        }
        App::invoked(new Invocation('psx:verify', ["--release={$release}"]));
        try {
            $app = require "{$base}/app.php";
        } finally {
            App::invoked(null);
        }
        return self::of($app);
    }

    /**
     * For an application already made to serve a release.
     */
    public static function of(App $app): self
    {
        $app->define();
        return new self($app, $app->container->get(Kernel::class));
    }

    public function container(): ContainerInterface
    {
        return $this->kernel->container;
    }

    /**
     * The release's id, which a page's requests name.
     */
    public function build(): string
    {
        return (string) $this->kernel->responder?->settings->build;
    }

    /**
     * Sends these headers with every request after: a cookie, an origin.
     *
     * @param array<string, string> $headers
     */
    public function withHeaders(array $headers): static
    {
        $new = clone $this;
        $new->headers = [...$this->headers, ...$headers];
        return $new;
    }

    /**
     * Asks for a page as a browser's address bar does.
     *
     * @param array<string, string> $headers
     */
    public function document(string $path, array $headers = []): PsxResponse
    {
        return $this->send(new Request('GET', $path, ['Accept' => 'text/html', ...$this->headers, ...$headers]));
    }

    /**
     * Asks for a page as the page's own navigation does.
     *
     * @param array<string, string> $headers Over the protocol's own, to send a stale build or none.
     */
    public function navigate(string $path, array $headers = []): PsxResponse
    {
        return $this->send(new Request('GET', $path, [
            ...$this->protocol((string) ($this->kernel->families['navigation'] ?? '')),
            ...$this->headers,
            ...$headers,
        ]));
    }

    /**
     * Calls a query.
     *
     * @param array<string, scalar> $parameters The path's.
     * @param array<string, mixed> $input The query string's.
     * @param array<string, string> $headers
     */
    public function query(
        string $mount,
        string $method,
        array $parameters = [],
        array $input = [],
        array $headers = [],
    ): PsxResponse {
        $operation = $this->operation($mount, $method, 'query');
        $query = $input === [] ? '' : '?' . http_build_query($input);
        return $this->send(new Request('GET', $this->address($operation['pattern'], $parameters) . $query, [
            ...$this->protocol($operation['schema']),
            ...$this->headers,
            ...$headers,
        ]));
    }

    /**
     * Calls an action with a JSON body, as `$action.at(scope)(input)` does.
     *
     * @param array<string, scalar> $parameters The path's.
     * @param array<string, mixed>|\stdClass $input The body.
     * @param array<string, string> $headers
     */
    public function action(
        string $mount,
        string $method,
        array $parameters = [],
        array|\stdClass $input = [],
        array $headers = [],
    ): PsxResponse {
        $operation = $this->operation($mount, $method, 'action');
        return $this->send(
            new Request(
                'POST',
                $this->address($operation['pattern'], $parameters),
                [
                    ...$this->protocol($operation['schema']),
                    'Content-Type' => 'application/json',
                    'Origin' => $this->origin(),
                    ...$this->headers,
                    ...$headers,
                ],
                json_encode($input === [] ? new \stdClass() : $input, JSON_THROW_ON_ERROR),
            ),
        );
    }

    /**
     * Calls an action with a form, as `$action.at(scope).form(formData)`
     * does: fields by their form names, "lines[0][quantity]", and files.
     *
     * @param array<string, scalar> $parameters The path's.
     * @param list<array{string, string|UploadedFileInterface|array{0: string, 1: string, 2?: string}}> $fields Each field's name and its text or its file, in order; a name may repeat. A file is an upload, or its name, its content and its media type.
     * @param array<string, string> $headers
     */
    public function form(
        string $mount,
        string $method,
        array $parameters = [],
        array $fields = [],
        array $headers = [],
    ): PsxResponse {
        $operation = $this->operation($mount, $method, 'action');
        $boundary = '----psx' . bin2hex(random_bytes(8));
        $body = '';
        foreach ($fields as [$name, $value]) {
            $body .= "--{$boundary}\r\nContent-Disposition: form-data; name=\"{$name}\"";
            if (is_array($value)) {
                // A file written as its name, its content and what the browser says it is.
                [$filename, $content, $type] = [...$value, 'application/octet-stream'];
                $body .= '; filename="' . addcslashes($filename, '"\\') . "\"\r\nContent-Type: {$type}";
                $value = $content;
            } elseif ($value instanceof UploadedFileInterface) {
                $body .=
                    '; filename="'
                    . addcslashes((string) $value->getClientFilename(), '"\\')
                    . "\"\r\nContent-Type: "
                    . ($value->getClientMediaType() ?? 'application/octet-stream');
                $value = (string) $value->getStream();
            }
            $body .= "\r\n\r\n{$value}\r\n";
        }
        $body .= "--{$boundary}--\r\n";
        return $this->send(
            new Request(
                'POST',
                $this->address($operation['pattern'], $parameters),
                [
                    ...$this->protocol($operation['schema']),
                    'Content-Type' => "multipart/form-data; boundary={$boundary}",
                    'Origin' => $this->origin(),
                    ...$this->headers,
                    ...$headers,
                ],
                $body,
            ),
        );
    }

    /**
     * Sends a request of the test's own making, for what the browser's
     * runtime would never send.
     */
    public function send(Request $request): PsxResponse
    {
        return new PsxResponse($this->app->handle($request));
    }

    /**
     * The address of a query or an action, for a request of the test's own making.
     *
     * @param array<string, scalar> $parameters
     */
    public function path(string $mount, string $method, array $parameters = []): string
    {
        foreach (['query', 'action'] as $role) {
            try {
                return $this->address($this->operation($mount, $method, $role)['pattern'], $parameters);
            } catch (PsxException) {
            }
        }
        throw new PsxException("{$mount} has no query or action {$method}().");
    }

    /**
     * The protocol's headers for a schema.
     *
     * @return array<string, string>
     */
    public function protocol(string $schema): array
    {
        return [
            'Accept' => Protocol::MEDIA,
            Protocol::PROTOCOL => (string) Protocol::VERSION,
            Protocol::BUILD => $this->build(),
            Protocol::SCHEMA => $schema,
        ];
    }

    /**
     * The schema id of a query or an action.
     */
    public function schema(string $mount, string $method): string
    {
        foreach (['query', 'action'] as $role) {
            try {
                return $this->operation($mount, $method, $role)['schema'];
            } catch (PsxException) {
            }
        }
        throw new PsxException("{$mount} has no query or action {$method}().");
    }

    /**
     * @return array<string, mixed>
     */
    private function operation(string $mount, string $method, string $role): array
    {
        $families = $this->kernel->families ?? ['routes' => [], 'services' => []];
        $wanted = str_contains($mount, '/') || isset($families['services'][$mount]) ? $mount : "{$mount}/page";
        foreach ([...$families['routes'], ...$families['services']] as $family) {
            foreach ($family['operations'] as $operation) {
                if (
                    $operation['mount'] === $wanted
                    && $operation['method'] === $method
                    && $operation['role'] === $role
                ) {
                    return $operation;
                }
            }
        }
        throw new PsxException(
            "{$mount} has no {$role} {$method}(). `php cua psx:list` shows what each page and service has.",
        );
    }

    /**
     * @param array<string, scalar> $parameters
     */
    private function address(string $pattern, array $parameters): string
    {
        return (string) preg_replace_callback(
            '/\{([A-Za-z_][A-Za-z0-9_]*)(?::(?:[^{}]++|\{[^{}]*\})+)?\}/',
            static function (array $match) use ($parameters, $pattern): string {
                if (!array_key_exists($match[1], $parameters)) {
                    throw new PsxException("{$pattern} needs the parameter {$match[1]}.");
                }
                return rawurlencode((string) $parameters[$match[1]]);
            },
            $pattern,
        );
    }

    private function origin(): string
    {
        $url = $this->kernel->container->get(\Crab\Contracts\Config\Config::class)->get('app.url');
        return is_string($url) ? rtrim($url, '/') : 'http://localhost';
    }
}
