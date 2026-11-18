<?php

declare(strict_types=1);

namespace Crab\Psx\Registry;

use Crab\Contracts\Http\Middleware;
use Crab\Psx\Contracts\PageGroup as PageGroupContract;
use Crab\Psx\Contracts\Pages;
use Crab\Psx\PsxException;
use Psr\Container\ContainerInterface;

/**
 * The pages, layouts and services an application declares. It is open
 * while plugins, the application's setup and its files declare, and is
 * sealed when the application is defined.
 */
final class Registry implements Pages
{
    /**
     * @var list<Declaration>
     */
    private array $pages = [];
    /**
     * @var array<string, Declaration>
     */
    private array $layouts = [];
    /**
     * @var list<Declaration>
     */
    private array $services = [];
    /**
     * The prefix and middleware of each group being declared, outermost first.
     *
     * @var list<array{string, list<Middleware|string>}>
     */
    private array $groups = [];
    private bool $sealed = false;

    /**
     * The folder of each kind's files, inside the resources folder, for a file named by its short name.
     */
    private const array FOLDERS = [
        Declaration::PAGE => 'pages',
        Declaration::LAYOUT => 'layouts',
        Declaration::SERVICE => 'components',
    ];

    /**
     * @param string $base The application's directory, which files are relative to.
     * @param string $resources The folder of the .psx files, relative to the application: "psx.resources".
     */
    public function __construct(
        private readonly string $base,
        private readonly ?ContainerInterface $container = null,
        private readonly string $resources = 'resources',
    ) {}

    public function page(string $path, string $file): Declaration
    {
        return $this->pages[] = $this->declare(Declaration::PAGE, null, $path, $file);
    }

    public function layout(string $name, string $file): Declaration
    {
        if (preg_match('/^[A-Za-z][A-Za-z0-9_]*$/', $name) !== 1) {
            throw new PsxException("A layout's name is one word, such as \"app\", not \"{$name}\".", $file);
        }
        if (isset($this->layouts[$name])) {
            throw new PsxException(
                "The layout {$name} is declared twice, for {$this->layouts[$name]->file} and for {$file}.",
                $file,
            );
        }
        if ($this->groups !== []) {
            throw new PsxException(
                "The layout {$name} is declared inside a group. A layout is declared on its own and takes its middleware with ->middleware(); a group's belongs to its pages.",
                $file,
            );
        }
        return $this->layouts[$name] = $this->declare(Declaration::LAYOUT, $name, null, $file);
    }

    public function service(string $path, string $file): Declaration
    {
        return $this->services[] = $this->declare(Declaration::SERVICE, null, $path, $file);
    }

    public function prefix(string $prefix): PageGroupContract
    {
        return new PageGroup($this->enter(...))->prefix($prefix);
    }

    public function middleware(Middleware|string ...$middleware): PageGroupContract
    {
        return new PageGroup($this->enter(...))->middleware(...$middleware);
    }

    /**
     * Takes no more declarations.
     */
    public function seal(): void
    {
        $this->sealed = true;
    }

    /**
     * @return list<Declaration>
     */
    public function pages(): array
    {
        return $this->pages;
    }

    /**
     * @return array<string, Declaration>
     */
    public function layouts(): array
    {
        return $this->layouts;
    }

    /**
     * @return list<Declaration>
     */
    public function services(): array
    {
        return $this->services;
    }

    /**
     * Every declaration: layouts, then pages, then services.
     *
     * @return list<Declaration>
     */
    public function all(): array
    {
        return [...array_values($this->layouts), ...$this->pages, ...$this->services];
    }

    /**
     * @param list<Middleware|string> $middleware
     */
    private function enter(string $prefix, array $middleware, \Closure $pages): void
    {
        $this->open('A group');
        $this->groups[] = [$prefix, $this->checked(...$middleware)];
        try {
            $pages($this);
        } finally {
            array_pop($this->groups);
        }
    }

    /**
     * The file a declaration names: a path ending in ".psx" as it is, or a
     * short name in the folder of its kind, "Posts/Edit" for a page being
     * resources/pages/Posts/Edit.psx.
     */
    private function file(string $kind, string $file): string
    {
        if (str_ends_with($file, '.psx')) {
            return $file;
        }
        if (preg_match('~^[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*$~', $file) !== 1) {
            throw new PsxException(
                "A {$kind} is named by a .psx file inside the application, such as resources/pages/Home.psx, or by its "
                . "name in the folder of its kind, such as \"Posts/Edit\" for resources/pages/Posts/Edit.psx; not \"{$file}\".",
                $file,
            );
        }
        return trim($this->resources, '/') . '/' . self::FOLDERS[$kind] . "/{$file}.psx";
    }

    private function declare(string $kind, ?string $name, ?string $path, string $file): Declaration
    {
        $this->open("The {$kind} {$file}");
        $file = $this->file($kind, $file);
        if (!str_ends_with($file, '.psx') || str_contains($file, '..') || str_starts_with($file, '/')) {
            throw new PsxException(
                "A {$kind} is a .psx file inside the application, such as resources/pages/Home.psx, not \"{$file}\".",
                $file,
            );
        }
        if (!is_file($this->base . '/' . $file)) {
            throw new PsxException("The {$kind} names a file that does not exist.", $file);
        }
        $middleware = [];
        if ($path !== null) {
            $prefix = '';
            foreach ($this->groups as [$groupPrefix, $groupMiddleware]) {
                $prefix .= $groupPrefix;
                $middleware = [...$middleware, ...$groupMiddleware];
            }
            if ($path === '' || $path[0] !== '/') {
                throw new PsxException("A {$kind}'s path starts with \"/\", not \"{$path}\".", $file);
            }
            if ($prefix !== '') {
                $path = $path === '/' ? $prefix : $prefix . $path;
            }
            if (preg_match('~(?:^|/)_psx(?:/|$)~', $path) === 1) {
                throw new PsxException(
                    "The path {$path} has the segment _psx, which is kept for the queries and actions of pages.",
                    $file,
                );
            }
        }
        return new Declaration(
            $kind,
            $name,
            $path,
            $file,
            $middleware,
            fn(): bool => $this->sealed,
            $this->checked(...),
        );
    }

    /**
     * Refuses, where it is declared, middleware that could never run.
     *
     * @return list<Middleware|string>
     */
    private function checked(Middleware|string ...$middleware): array
    {
        foreach ($middleware as $layer) {
            if ($layer instanceof Middleware) {
                continue;
            }
            if (class_exists($layer) || interface_exists($layer)) {
                if (!is_a($layer, Middleware::class, true)) {
                    throw new PsxException(
                        "{$layer} is named as middleware, and it is not one. Make it implement "
                        . Middleware::class
                        . '.',
                    );
                }
                continue;
            }
            if ($this->container === null || !$this->container->has($layer)) {
                throw new PsxException(
                    "{$layer} is named as middleware, and there is no such class. Check the name and its namespace.",
                );
            }
        }
        return array_values($middleware);
    }

    private function open(string $what): void
    {
        if ($this->sealed) {
            throw new PsxException(
                "{$what} was declared after the application was defined. Declare it in a file PsxPlugin is given, or in a plugin's register().",
            );
        }
    }
}
