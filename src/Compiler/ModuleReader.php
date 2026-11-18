<?php

declare(strict_types=1);

namespace Crab\Psx\Compiler;

use Crab\Psx\Action;
use Crab\Psx\ActionResult;
use Crab\Psx\Failure;
use Crab\Psx\PageData;
use Crab\Psx\PsxException;
use Crab\Psx\Query;
use Crab\Psx\QueryData;
use Crab\Psx\Redirect;

/**
 * Reads a compiled module's Server class: its loader and the methods it
 * exposes, and what each returns. The class is reflected, never made and
 * never called.
 *
 * @internal
 */
final class ModuleReader
{
    private const array WRAPPERS = [
        PageData::class => 'load',
        QueryData::class => 'query',
        ActionResult::class => 'action',
    ];

    /**
     * @return array{class: class-string|null, load: array<string, mixed>|null, operations: array<string, array<string, mixed>>}
     */
    public static function read(Source $source): array
    {
        $module = ['class' => null, 'load' => null, 'operations' => []];
        if (!$source->server) {
            return $module;
        }
        $class = $source->namespace . '\\Server';
        $reflection = new \ReflectionClass($class);
        $module['class'] = $class;
        foreach (['__call', '__callStatic', '__invoke', '__get'] as $magic) {
            if ($reflection->hasMethod($magic)) {
                throw self::error(
                    $source,
                    $reflection->getMethod($magic),
                    "The Server class has {$magic}(), and a page calls only methods marked #[Query] or #[Action].",
                );
            }
        }
        foreach ($reflection->getProperties() as $property) {
            if ($property->isStatic()) {
                throw new PsxException(
                    "The Server class has the static property \${$property->getName()}, which every request of a worker would share.",
                    $source->file,
                );
            }
        }
        foreach ($reflection->getMethods() as $method) {
            if ($method->isConstructor() || !$method->isPublic()) {
                if ($method->getAttributes(Query::class) !== [] || $method->getAttributes(Action::class) !== []) {
                    throw self::error(
                        $source,
                        $method,
                        "{$method->getName()}() is marked for the page to call, and is not public.",
                    );
                }
                continue;
            }
            if ($method->isStatic()) {
                throw self::error(
                    $source,
                    $method,
                    "{$method->getName()}() is static; the methods of a Server class are its object's.",
                );
            }
            $query = $method->getAttributes(Query::class) !== [];
            $action = $method->getAttributes(Action::class);
            $name = $method->getName();
            if ($name === 'load') {
                if ($query || $action !== []) {
                    throw self::error(
                        $source,
                        $method,
                        'load() is the page\'s loader and is not called by the page; drop its #[Query] or #[Action].',
                    );
                }
                $module['load'] = [...self::returns($source, $method, 'load'), 'line' => $method->getStartLine()];
                continue;
            }
            if ($query && $action !== []) {
                throw self::error(
                    $source,
                    $method,
                    "{$name}() is marked both #[Query] and #[Action]; it reads or it changes.",
                );
            }
            if (!$query && $action === []) {
                throw self::error(
                    $source,
                    $method,
                    "{$name}() is public and marked neither #[Query] nor #[Action]. Mark it for the page to call, or make it private.",
                );
            }
            if (preg_match('/^[a-z][A-Za-z0-9]*$/', $name) !== 1) {
                throw self::error(
                    $source,
                    $method,
                    "{$name}() is called by the page as \${$name}; name it in camelCase.",
                );
            }
            $module['operations'][$name] = [
                'role' => $query ? 'query' : 'action',
                'auth' => $action !== [] && $action[0]->newInstance()->auth,
                'line' => $method->getStartLine(),
                ...self::returns($source, $method, $query ? 'query' : 'action'),
            ];
        }
        return $module;
    }

    /**
     * What a method returns: the shape of its data, and whether it may
     * also return a Failure or a Redirect.
     *
     * @return array{shape: array<string, mixed>, wrapper: bool, failure: bool, redirect: bool}
     */
    private static function returns(Source $source, \ReflectionMethod $method, string $role): array
    {
        $name = $method->getName();
        $type = $method->getReturnType();
        if ($type === null) {
            throw self::error(
                $source,
                $method,
                "{$name}() declares no return type, so the page cannot know what it receives.",
            );
        }
        $members = [];
        foreach ($type instanceof \ReflectionUnionType ? $type->getTypes() : [$type] as $member) {
            if (!$member instanceof \ReflectionNamedType) {
                throw self::error(
                    $source,
                    $method,
                    "{$name}() returns \"{$type}\", which is not a plain type or a union with Failure and Redirect.",
                );
            }
            $members[] = $member;
        }
        $failure = false;
        $redirect = false;
        $data = [];
        foreach ($members as $member) {
            match ($member->getName()) {
                Failure::class => $failure = true,
                Redirect::class => $redirect = true,
                'null' => null,
                default => $data[] = $member,
            };
        }
        if (($failure || $redirect) && $role === 'action') {
            throw self::error(
                $source,
                $method,
                "{$name}() is an action and returns Failure or Redirect beside its data. Return an ActionResult, which holds either: ActionResult::fail(...) or ActionResult::ok(...)->redirect(...).",
            );
        }
        if (count($data) !== 1) {
            throw self::error(
                $source,
                $method,
                "{$name}() returns \"{$type}\"; beside Failure and Redirect it returns one type.",
            );
        }
        $returned = $data[0]->getName();
        $where = "{$source->file}: {$name}()";
        if (isset(self::WRAPPERS[$returned])) {
            if (self::WRAPPERS[$returned] !== $role) {
                $short = substr((string) strrchr($returned, '\\'), 1);
                throw self::error(
                    $source,
                    $method,
                    "{$name}() returns {$short}, which is what a " . self::WRAPPERS[$returned] . ' returns.',
                );
            }
            $shape = Shapes::ofExpression(
                self::generic($source, $method, $returned, $failure, $redirect),
                static fn(string $class): string => self::resolve($source, $class),
                $where,
            );
        } else {
            $shape = Shapes::ofType($data[0], $where);
            if ($type->allowsNull() && $shape['k'] !== 'nullable' && $shape['k'] !== 'null') {
                $shape = ['k' => 'nullable', 'of' => $shape];
            }
        }
        if ($role === 'load' && !in_array($shape['k'], ['object', 'null'], true)) {
            throw self::error(
                $source,
                $method,
                'load() returns the page\'s props, which are a class of its own: a final readonly class, or PageData of one.',
            );
        }
        return [
            'shape' => $shape,
            'wrapper' => isset(self::WRAPPERS[$returned]),
            'failure' => $failure,
            'redirect' => $redirect,
        ];
    }

    /**
     * The type inside a wrapper, from the method's docblock: the
     * "EditData" of "@return PageData<EditData>|Failure". The docblock
     * must name the same types as the native return type.
     *
     * @param class-string $wrapper
     */
    private static function generic(
        Source $source,
        \ReflectionMethod $method,
        string $wrapper,
        bool $failure,
        bool $redirect,
    ): string {
        $short = substr((string) strrchr($wrapper, '\\'), 1);
        $name = $method->getName();
        $example = "@return {$short}<YourData>" . ($failure ? '|Failure' : '') . ($redirect ? '|Redirect' : '');
        $doc = $method->getDocComment();
        if ($doc === false || preg_match('/@return\s+([^\r\n]+?)\s*(?:\*\/|$)/m', $doc, $match) !== 1) {
            throw self::error(
                $source,
                $method,
                "{$name}() returns {$short} and has no docblock saying of what. Add \"{$example}\" above it.",
            );
        }
        $parts = [];
        $depth = 0;
        $part = '';
        foreach (str_split(trim($match[1])) as $character) {
            $depth += $character === '<' ? 1 : ($character === '>' ? -1 : 0);
            if ($character === '|' && $depth === 0) {
                $parts[] = trim($part);
                $part = '';
                continue;
            }
            $part .= $character;
        }
        $parts[] = trim($part);
        $inner = null;
        $expected = [$short, ...($failure ? ['Failure'] : []), ...($redirect ? ['Redirect'] : [])];
        $found = [];
        foreach ($parts as $written) {
            if (preg_match('/^\\\\?([A-Za-z0-9_\\\\]+)(?:<(.+)>)?$/', $written, $type) !== 1) {
                throw self::error(
                    $source,
                    $method,
                    "{$name}()'s docblock says \"{$written}\", which cannot be read. Write \"{$example}\".",
                );
            }
            $class = self::resolve($source, $type[1]);
            $found[] = substr((string) strrchr('\\' . $class, '\\'), 1);
            if ($class === $wrapper) {
                $inner = $type[2] ?? null;
            } elseif (!in_array($class, [Failure::class, Redirect::class], true) || isset($type[2])) {
                throw self::error(
                    $source,
                    $method,
                    "{$name}()'s docblock names {$written}, which its return type does not. Write \"{$example}\".",
                );
            }
        }
        sort($expected);
        sort($found);
        if ($expected !== $found || $inner === null) {
            throw self::error(
                $source,
                $method,
                "{$name}()'s docblock and its return type disagree. Write \"{$example}\".",
            );
        }
        return $inner;
    }

    /**
     * The full name of a class as the file's PHP wrote it.
     */
    private static function resolve(Source $source, string $name): string
    {
        if ($name[0] === '\\') {
            return substr($name, 1);
        }
        $first = strstr($name, '\\', true) ?: $name;
        if (isset($source->uses[$first])) {
            return $source->uses[$first] . substr($name, strlen($first));
        }
        return in_array($first, $source->declared, true) || !class_exists($name) && !enum_exists($name)
            ? $source->namespace . '\\' . $name
            : $name;
    }

    private static function error(Source $source, \ReflectionMethod $method, string $message): PsxException
    {
        return new PsxException($message, $source->file, $method->getStartLine() ?: null);
    }
}
