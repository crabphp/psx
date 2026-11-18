<?php

declare(strict_types=1);

namespace Crab\Psx\Compiler;

use Crab\Contracts\Routing\Actions;
use Crab\Contracts\Routing\InputProjection;
use Crab\Contracts\Routing\PreparedAction;
use Crab\Psx\PsxException;
use Crab\Psx\Registry\Declaration;
use Crab\Psx\Registry\Registry;

/**
 * Expands the declared pages, layouts and services into what is served:
 * for each page its chain of loaders and every query and action of the
 * chain, each with a route of its own; for each service its queries and
 * actions. The compiler writes the page's side of this, and a serving
 * application its routes, from the same expansion.
 *
 * Nothing here runs a loader: the methods are prepared, which reads
 * their signatures.
 *
 * @internal
 */
final class Families
{
    /**
     * A parameter in a pattern: {name}, or {name:expression}.
     */
    private const string PARAMETER = '/\{([A-Za-z_][A-Za-z0-9_]*)(?::((?:[^{}]++|\{[^{}]*\})+))?\}/';

    /**
     * @param array<string, array<string, mixed>> $modules Each compiled module by its file, as ModuleReader read it, with its "id".
     * @return array{routes: array<string, array<string, mixed>>, services: array<string, array<string, mixed>>, navigation: string}
     */
    public static function build(Registry $registry, array $modules, Actions $actions): array
    {
        $names = [];
        $routes = [];
        $services = [];
        foreach ($registry->pages() as $page) {
            $name = self::named($page, $names);
            $path = (string) $page->path;
            $nodes = [];
            $operations = [];
            $middleware = $page->middleware;
            $before = [];
            foreach ($page->layouts as $layoutName) {
                $layout = $registry->layouts()[$layoutName] ?? null;
                if ($layout === null) {
                    throw new PsxException(
                        "{$page->label()} is put in the layout \"{$layoutName}\", and none is declared by that name. Declare it with \$pages->layout('{$layoutName}', ...).",
                        $page->file,
                    );
                }
                $before = [...$before, ...$layout->middleware];
                $nodes[] = self::node($layout, $name, $path, $modules, $actions);
            }
            // The groups' and the layouts' guards, outer first, then the page's own.
            $middleware = [...self::groups($page), ...$before, ...self::own($page)];
            $nodes[] = self::node($page, $name, $path, $modules, $actions);
            foreach ($nodes as $node) {
                $operations += self::operations(
                    $node['declaration'],
                    $node['mount'],
                    "psx.{$name}." . ($node['layout'] ?? 'page'),
                    $path,
                    $modules,
                    $actions,
                    $middleware,
                );
            }
            self::reachable($page, $path, $operations);
            $query = self::composite($nodes, $page);
            foreach ($nodes as $index => $node) {
                $own = array_keys($node['query']);
                $nodes[$index]['projection'] = new InputProjection(array_values(array_diff(array_keys($query), $own)));
                $nodes[$index]['identity'] = self::identity($node, $operations, $path);
            }
            $routes[$name] = [
                'name' => $name,
                'path' => $path,
                'segments' => self::segments($path),
                'file' => $page->file,
                'rendering' => $page->rendering,
                'middleware' => $middleware,
                'query' => $query,
                'nodes' => $nodes,
                'operations' => $operations,
                'schema' => self::hash([
                    $path,
                    $query,
                    array_map(static fn(array $node): array => [
                        $node['mount'],
                        $node['module'],
                        $node['shape'],
                    ], $nodes),
                ]),
            ];
        }
        // One schema for every navigation: which page an address is, is the server's to say.
        $navigation = self::hash(array_map(static fn(array $route): array => [
            $route['name'],
            $route['schema'],
        ], array_values($routes)));
        foreach (array_keys($routes) as $name) {
            $routes[$name]['navigation'] = $navigation;
        }
        foreach ($registry->services() as $service) {
            $name = self::named($service, $names);
            $path = (string) $service->path;
            $module = self::module($service, $modules);
            if ($module['load'] !== null) {
                throw new PsxException(
                    "{$service->label()} has a load(), which only a page or a layout has: a service is asked for what it has with a #[Query].",
                    $service->file,
                );
            }
            $services[$name] = [
                'name' => $name,
                'path' => $path,
                'segments' => self::segments($path),
                'file' => $service->file,
                'module' => $module['id'],
                'middleware' => $service->middleware,
                'operations' => self::operations(
                    $service,
                    $name,
                    "psx.{$name}",
                    $path,
                    $modules,
                    $actions,
                    $service->middleware,
                ),
            ];
        }
        foreach ($registry->layouts() as $layout) {
            self::module($layout, $modules);
        }
        return ['routes' => $routes, 'services' => $services, 'navigation' => $navigation];
    }

    /**
     * What identifies the declarations a release was compiled from; a
     * serving application's must be the same.
     *
     * @param array{routes: array<string, array<string, mixed>>, services: array<string, array<string, mixed>>} $families
     */
    public static function fingerprint(array $families): string
    {
        $parts = [];
        foreach ($families['routes'] as $route) {
            $parts[] = [
                $route['name'],
                $route['path'],
                $route['schema'],
                $route['rendering'],
                array_map(self::guard(...), $route['middleware']),
                array_map(static fn(array $node): array => [
                    $node['mount'],
                    $node['module'],
                    $node['identity'],
                ], $route['nodes']),
                array_map(self::signed(...), $route['operations']),
            ];
        }
        foreach ($families['services'] as $service) {
            $parts[] = [
                $service['name'],
                $service['path'],
                array_map(self::guard(...), $service['middleware']),
                array_map(self::signed(...), $service['operations']),
            ];
        }
        return self::hash($parts);
    }

    /**
     * The parts of a path: its text, and its parameters with their expressions.
     *
     * @return list<array{text?: string, name?: string, expression?: string|null}>
     */
    public static function segments(string $path): array
    {
        preg_match_all(self::PARAMETER, $path, $matches, PREG_SET_ORDER | PREG_OFFSET_CAPTURE);
        $segments = [];
        $offset = 0;
        foreach ($matches as $match) {
            if ($match[0][1] > $offset) {
                $segments[] = ['text' => substr($path, $offset, $match[0][1] - $offset)];
            }
            $segments[] = ['name' => $match[1][0], 'expression' => $match[2][0] ?? null];
            $offset = $match[0][1] + strlen($match[0][0]);
        }
        if ($offset < strlen($path)) {
            $segments[] = ['text' => substr($path, $offset)];
        }
        return $segments;
    }

    /**
     * The first 16 hex digits of a value's hash.
     */
    public static function hash(mixed $value): string
    {
        return substr(
            hash('sha256', json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)),
            0,
            16,
        );
    }

    /**
     * @param array<string, string> $names
     */
    private static function named(Declaration $declaration, array &$names): string
    {
        if ($declaration->name === null) {
            throw new PsxException(
                "{$declaration->label()} has no name. Give it one with ->name('posts.edit'): the TSX builds its address by it.",
                $declaration->file,
            );
        }
        if (isset($names[$declaration->name])) {
            throw new PsxException(
                "{$declaration->label()} is named \"{$declaration->name}\", and so is {$names[$declaration->name]}.",
                $declaration->file,
            );
        }
        foreach (array_keys($names) as $taken) {
            if (
                str_starts_with($taken, $declaration->name . '.') || str_starts_with($declaration->name, $taken . '.')
            ) {
                throw new PsxException(
                    "{$declaration->label()} is named \"{$declaration->name}\", which cannot stand beside \"{$taken}\": the TSX reads one as a part of the other.",
                    $declaration->file,
                );
            }
        }
        $names[$declaration->name] = lcfirst($declaration->label());
        return $declaration->name;
    }

    /**
     * @param array<string, array<string, mixed>> $modules
     * @return array<string, mixed>
     */
    private static function module(Declaration $declaration, array $modules): array
    {
        $module = $modules[$declaration->file] ?? null;
        if ($module === null) {
            throw new PsxException("{$declaration->label()} was not compiled.", $declaration->file);
        }
        foreach (array_keys($declaration->operations) as $method) {
            if (!isset($module['operations'][$method])) {
                throw new PsxException(
                    "{$declaration->label()} guards the operation \"{$method}\", and its Server class has no #[Query] or #[Action] by that name.",
                    $declaration->file,
                );
            }
        }
        return $module;
    }

    /**
     * One loader of a page's chain.
     *
     * @param array<string, array<string, mixed>> $modules
     * @return array<string, mixed>
     */
    private static function node(
        Declaration $declaration,
        string $route,
        string $path,
        array $modules,
        Actions $actions,
    ): array {
        $module = self::module($declaration, $modules);
        $layout = $declaration->kind === Declaration::LAYOUT ? $declaration->name : null;
        $load = null;
        $query = [];
        $strict = false;
        $parameters = [];
        if ($module['load'] !== null) {
            $load = self::prepare($actions, 'GET', $path, [$module['class'], 'load'], $declaration);
            $input = $load->input();
            self::exact($input, 'load()', $declaration, $module['load']['line'] ?? null);
            if (isset($input['body'])) {
                throw new PsxException(
                    "{$declaration->label()}'s load() takes a body, and a page is loaded by a GET. Mark what it reads from the address #[FromQuery].",
                    $declaration->file,
                    $module['load']['line'] ?? null,
                );
            }
            $query = (array) ($input['query']['properties'] ?? []);
            foreach ($query as $name => $schema) {
                $query[$name] = [
                    'schema' => $schema,
                    'required' => in_array($name, $input['query']['required'] ?? [], true),
                ];
            }
            $strict = ($input['query']['additionalProperties'] ?? true) === false;
            $parameters = array_keys((array) $input['parameters']);
        }
        return [
            'declaration' => $declaration,
            'mount' => $route . '/' . ($layout ?? 'page'),
            'layout' => $layout,
            'module' => $module['id'],
            'class' => $module['class'],
            'load' => $load,
            'query' => $query,
            'strict' => $strict,
            'parameters' => $parameters,
            'shape' => $module['load']['shape'] ?? ['k' => 'null'],
            'wrapper' => $module['load']['wrapper'] ?? false,
        ];
    }

    /**
     * A page's queries are asked for under its own address, and the page
     * answers GET there first. A path with a parameter that may take
     * more than one segment, "/files/{tail:.+}", may take the queries'
     * addresses for the page's own, and they would not be reached: such
     * a family is refused here unless the two patterns are proven apart,
     * and nothing about how routes are found is changed for it.
     *
     * @param array<string, array<string, mixed>> $operations
     */
    private static function reachable(Declaration $page, string $path, array $operations): void
    {
        foreach ($operations as $operation) {
            if ($operation['role'] !== 'query' || !Addresses::shadows($path, $operation['pattern'])) {
                continue;
            }
            $parameter = Addresses::spanning($path) ?? 'a parameter';
            throw new PsxException(
                "{$page->label()} has {$parameter} in its path, which is not known to stop at a \"/\": it then takes every segment after it, and so the address of the query {$operation['method']}() ({$operation['file']}) as well, and the page would answer in its place. Give the parameter an expression of letters, digits, \"_\", \".\" and \"-\" alone, such as {name:[A-Za-z0-9_.-]+}, which is seen to stop there; or keep the page, and declare what it asks with \$pages->service('/a/path/of/its/own', ...), whose address the parameter does not take.",
                $page->file,
            );
        }
    }

    /**
     * What a method takes is typed for the browser, and a whole number
     * past 2^53 - 1 either way is no number a browser can write: an enum
     * backed by one could be named by no page, and is refused where it
     * is declared instead of where a request would name it.
     *
     * @param array<mixed>|null $schema The method's input, as JSON Schema.
     */
    private static function exact(?array $schema, string $method, Declaration $declaration, ?int $line): void
    {
        foreach ($schema ?? [] as $key => $value) {
            // The cases of an enum are a list. A map under that key is the schema of a field that is
            // itself named "enum", and is read through like any other.
            if ($key === 'enum' && is_array($value) && array_is_list($value)) {
                foreach ($value as $case) {
                    if (is_int($case) && abs($case) > Shapes::SAFE) {
                        throw new PsxException(
                            "{$method} takes an enum with the value {$case}: a whole number past 9007199254740991 either way, which a browser reads as another number. Back the enum with strings, or keep its values within that.",
                            $declaration->file,
                            $line,
                        );
                    }
                }
            } elseif (is_array($value)) {
                self::exact($value, $method, $declaration, $line);
            }
        }
    }

    /**
     * The queries and actions of one declaration, mounted on a path.
     *
     * @param array<string, array<string, mixed>> $modules
     * @param list<mixed> $middleware The guards of the family they are mounted in.
     * @return array<string, array<string, mixed>> By operation id.
     */
    private static function operations(
        Declaration $declaration,
        string $mount,
        string $name,
        string $path,
        array $modules,
        Actions $actions,
        array $middleware,
    ): array {
        $module = self::module($declaration, $modules);
        $operations = [];
        foreach ($module['operations'] as $method => $operation) {
            $role = $operation['role'];
            $id = self::hash([$mount, $module['id'], $method, $role]);
            $pattern = rtrim($path, '/') . '/_psx/' . ($role === 'query' ? 'q' : 'a') . '/' . $id;
            $prepared = self::prepare(
                $actions,
                $role === 'query' ? 'GET' : 'POST',
                $pattern,
                [$module['class'], $method],
                $declaration,
            );
            $input = $prepared->input();
            $line = $operation['line'] ?? null;
            self::exact($input, "{$method}()", $declaration, $line);
            if ($role === 'query' && isset($input['body'])) {
                throw new PsxException(
                    "The query {$method}() takes a body. A query is a GET: mark what it reads #[FromQuery], or make it an #[Action].",
                    $declaration->file,
                    $line,
                );
            }
            if ($role === 'action' && isset($input['query'])) {
                throw new PsxException(
                    "The action {$method}() reads the query string. An action takes the path's parameters and one body; put the option in the body.",
                    $declaration->file,
                    $line,
                );
            }
            $body = $input['body'] ?? null;
            foreach (array_keys((array) $input['parameters']) as $parameter) {
                if (isset($body['properties']) && array_key_exists($parameter, (array) $body['properties'])) {
                    throw new PsxException(
                        "The action {$method}() takes \"{$parameter}\" from the path and again in its body; the path's is the one that is checked.",
                        $declaration->file,
                        $line,
                    );
                }
            }
            $schema = $role === 'query' ? $input['query'] ?? null : $body;
            $operations[$id] = [
                'id' => $id,
                'mount' => $mount,
                'module' => $module['id'],
                'method' => $method,
                'role' => $role,
                'auth' => $operation['auth'],
                'pattern' => $pattern,
                'name' => "{$name}.{$role}.{$method}",
                'middleware' => [...$middleware, ...($declaration->operations[$method] ?? [])],
                'prepared' => $prepared,
                'input' => $schema,
                'parameters' => array_keys((array) $input['parameters']),
                'files' => $schema !== null && self::files($schema),
                'shape' => $operation['shape'],
                'wrapper' => $operation['wrapper'],
                'schema' => self::hash([$schema, $operation['shape'], $input['parameters']]),
                'file' => $declaration->file,
                'line' => $line,
            ];
        }
        return $operations;
    }

    /**
     * The query fields of every loader of a chain as one schema. A name
     * two loaders read must mean the same to both.
     *
     * @param list<array<string, mixed>> $nodes
     * @return array<string, array{schema: mixed, required: bool, strict: bool}>
     */
    private static function composite(array $nodes, Declaration $page): array
    {
        $composite = [];
        $owners = [];
        foreach ($nodes as $node) {
            foreach ($node['query'] as $name => $field) {
                if (isset($composite[$name]) && json_encode($composite[$name]) !== json_encode($field)) {
                    throw new PsxException(
                        "{$page->label()} reads the query field \"{$name}\" in {$owners[$name]} and in {$node['declaration']->file}, and they declare it differently. Give it one type, default and rules, or two names.",
                        $node['declaration']->file,
                    );
                }
                $composite[$name] = $field;
                $owners[$name] = $node['declaration']->file;
            }
        }
        return $composite;
    }

    /**
     * The path parameters a node's React state is kept by. A page is
     * kept by all of its path's; a layout by what it says, or by those
     * its loader and its operations read.
     *
     * @param array<string, mixed> $node
     * @param array<string, array<string, mixed>> $operations
     * @return list<string>
     */
    private static function identity(array $node, array $operations, string $path): array
    {
        $all = array_column(
            array_filter(self::segments($path), static fn(array $part): bool => isset($part['name'])),
            'name',
        );
        $declaration = $node['declaration'];
        if ($declaration->kind === Declaration::PAGE) {
            return $all;
        }
        if ($declaration->identity !== null) {
            foreach ($declaration->identity as $name) {
                if (!in_array($name, $all, true)) {
                    throw new PsxException(
                        "{$declaration->label()} is kept by the path parameter \"{$name}\", which {$path} does not have.",
                        $declaration->file,
                    );
                }
            }
            return $declaration->identity;
        }
        $used = $node['parameters'];
        foreach ($operations as $operation) {
            if ($operation['mount'] === $node['mount']) {
                $used = [...$used, ...$operation['parameters']];
            }
        }
        return array_values(array_intersect($all, $used));
    }

    /**
     * @param array{class-string, string} $action
     */
    private static function prepare(
        Actions $actions,
        string $method,
        string $pattern,
        array $action,
        Declaration $declaration,
    ): PreparedAction {
        try {
            return $actions->prepare($method, $pattern, $action);
        } catch (PsxException $refused) {
            throw $refused;
        } catch (\LogicException|\InvalidArgumentException $refused) {
            $line = new \ReflectionMethod(...$action)->getStartLine();
            throw new PsxException(
                "{$declaration->label()}: " . self::readable($refused->getMessage(), $action),
                $declaration->file,
                $line ?: null,
                $refused,
            );
        }
    }

    /**
     * A refusal of Crab's, naming the method as its file does.
     *
     * @param array{class-string, string} $action
     */
    private static function readable(string $message, array $action): string
    {
        // The file's Server class is the compiler's, made from its functions: name the function.
        return str_replace([$action[0] . '::', $action[0]], ['', 'Server'], $message);
    }

    /**
     * Whether a schema holds a file anywhere, which only a form carries.
     */
    private static function files(mixed $schema): bool
    {
        if (!is_array($schema)) {
            return false;
        }
        if (($schema['format'] ?? null) === 'binary') {
            return true;
        }
        foreach ($schema as $value) {
            if (self::files($value)) {
                return true;
            }
        }
        return false;
    }

    /**
     * @return list<mixed>
     */
    private static function groups(Declaration $page): array
    {
        return array_slice($page->middleware, 0, $page->grouped);
    }

    /**
     * @return list<mixed>
     */
    private static function own(Declaration $page): array
    {
        return array_slice($page->middleware, $page->grouped);
    }

    private static function guard(mixed $middleware): string
    {
        return is_string($middleware) ? $middleware : $middleware::class;
    }

    /**
     * @param array<string, mixed> $operation
     * @return list<mixed>
     */
    private static function signed(array $operation): array
    {
        return [
            $operation['id'],
            $operation['schema'],
            $operation['auth'],
            array_map(self::guard(...), $operation['middleware']),
        ];
    }
}
