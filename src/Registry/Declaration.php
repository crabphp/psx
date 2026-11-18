<?php

declare(strict_types=1);

namespace Crab\Psx\Registry;

use Crab\Contracts\Http\Middleware;
use Crab\Psx\Contracts\LayoutDeclaration;
use Crab\Psx\Contracts\PageDeclaration;
use Crab\Psx\Contracts\ServiceDeclaration;
use Crab\Psx\PsxException;

/**
 * One page, layout or service as it was declared: what the registry
 * keeps, and what the chained calls add to. It can be added to until the
 * registry is sealed.
 *
 * @internal
 */
final class Declaration implements PageDeclaration, LayoutDeclaration, ServiceDeclaration
{
    public const string PAGE = 'page';
    public const string LAYOUT = 'layout';
    public const string SERVICE = 'service';

    /**
     * The middleware around the whole family, its groups' first.
     *
     * @var list<Middleware|string>
     */
    public array $middleware;
    /**
     * More middleware by method of the declaration's own file.
     *
     * @var array<string, list<Middleware|string>>
     */
    public array $operations = [];
    /**
     * @var list<string>
     */
    public array $layouts = [];
    public ?string $rendering = null;
    /**
     * @var list<string>|null
     */
    public ?array $identity = null;

    /**
     * How many of its middleware came from the groups it was declared in; the rest are its own.
     */
    public readonly int $grouped;

    /**
     * @param string $kind PAGE, LAYOUT or SERVICE.
     * @param string|null $name A layout's name from the start; a page's or a service's once name() is called.
     * @param string|null $path The path pattern; null for a layout.
     * @param string $file The .psx file, relative to the application.
     * @param list<Middleware|string> $middleware
     * @param \Closure(): bool $sealed Whether the registry no longer takes changes.
     * @param \Closure(Middleware|string ...): list<Middleware|string> $checked Refuses what could never run as middleware.
     */
    public function __construct(
        public readonly string $kind,
        public ?string $name,
        public readonly ?string $path,
        public readonly string $file,
        array $middleware,
        private readonly \Closure $sealed,
        private readonly \Closure $checked,
    ) {
        $this->middleware = $middleware;
        $this->grouped = count($middleware);
    }

    public function name(string $name): static
    {
        $this->open('name');
        if ($this->kind === self::LAYOUT) {
            throw new PsxException("The layout {$this->name} was named where it was declared.", $this->file);
        }
        if ($this->name !== null) {
            throw new PsxException(
                "{$this->label()} is named \"{$this->name}\" already; it has one name.",
                $this->file,
            );
        }
        if (preg_match('/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/', $name) !== 1) {
            throw new PsxException(
                "{$this->label()} is named \"{$name}\"; a name is words joined by dots, such as \"posts.edit\", since the TSX reads it as routes.posts.edit.",
                $this->file,
            );
        }
        $this->name = $name;
        return $this;
    }

    public function middleware(Middleware|string ...$middleware): static
    {
        $this->open('middleware');
        $this->middleware = [...$this->middleware, ...($this->checked)(...$middleware)];
        return $this;
    }

    public function operation(string $method, Middleware|string ...$middleware): static
    {
        $this->open('operation');
        $this->operations[$method] = [...($this->operations[$method] ?? []), ...($this->checked)(...$middleware)];
        return $this;
    }

    public function layout(string ...$names): static
    {
        $this->open('layout');
        if ($this->kind !== self::PAGE) {
            throw new PsxException("{$this->label()} has no layouts; only a page is put in them.", $this->file);
        }
        $this->layouts = [...$this->layouts, ...array_values($names)];
        if (count(array_unique($this->layouts)) !== count($this->layouts)) {
            throw new PsxException("{$this->label()} is put in the same layout twice.", $this->file);
        }
        return $this;
    }

    public function rendering(string $mode): static
    {
        $this->open('rendering');
        if (!in_array($mode, ['client', 'server'], true)) {
            throw new PsxException(
                "{$this->label()} is rendered \"client\" or \"server\", not \"{$mode}\".",
                $this->file,
            );
        }
        $this->rendering = $mode;
        return $this;
    }

    public function identity(string ...$pathParameters): static
    {
        $this->open('identity');
        $this->identity = array_values($pathParameters);
        return $this;
    }

    /**
     * What it is, for a message: "The page /posts/{id}".
     */
    public function label(): string
    {
        return match ($this->kind) {
            self::PAGE => "The page {$this->path}",
            self::SERVICE => "The service {$this->path}",
            default => "The layout {$this->name}",
        };
    }

    private function open(string $method): void
    {
        if (($this->sealed)()) {
            throw new PsxException(
                "{$this->label()} was given {$method}() after the application was defined. Say it in the file that declares it.",
                $this->file,
            );
        }
    }
}
