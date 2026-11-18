<?php

declare(strict_types=1);

namespace Crab\Psx\Compiler;

use Crab\Psx\MapOf;
use Crab\Psx\PsxException;
use Crab\Validation\ListOf;

/**
 * Reads what an output is from its declared types: the shape a value
 * must have to be sent to the page, which is also the TypeScript type
 * the page is given. Nothing is run and no value is looked at: a type
 * that does not say what it holds is refused.
 *
 * A shape is an array with a kind, "k":
 *
 *     string, int, float, bool, null, date
 *     enum      values: the backing values
 *     list      of: the shape of each item
 *     map       of: the shape of each value, by text keys
 *     object    class, name, props: the shape of each public property
 *     nullable  of: the shape when not null
 *
 * @internal
 */
final class Shapes
{
    /**
     * The largest whole number a browser holds exactly, 2^53 - 1.
     */
    public const int SAFE = 9_007_199_254_740_991;

    private const array SCALARS = [
        'string' => 'string',
        'int' => 'int',
        'float' => 'float',
        'bool' => 'bool',
        'null' => 'null',
        'void' => 'null',
    ];

    /**
     * The shape of a type written as text: a class, a scalar, "?T",
     * "list<T>" or "array<string, T>".
     *
     * @param \Closure(string): string $resolve Gives the full name of a class written as in the file.
     * @param string $where What declares it, for a message.
     * @return array<string, mixed>
     */
    public static function ofExpression(string $expression, \Closure $resolve, string $where): array
    {
        $expression = trim($expression);
        if (str_starts_with($expression, '?')) {
            return ['k' => 'nullable', 'of' => self::ofExpression(substr($expression, 1), $resolve, $where)];
        }
        if (preg_match('/^(.+)\|null$/', $expression, $match) === 1) {
            return ['k' => 'nullable', 'of' => self::ofExpression($match[1], $resolve, $where)];
        }
        if (preg_match('/^list<(.+)>$/', $expression, $match) === 1) {
            return ['k' => 'list', 'of' => self::ofExpression($match[1], $resolve, $where)];
        }
        if (preg_match('/^array<\s*string\s*,(.+)>$/', $expression, $match) === 1) {
            return ['k' => 'map', 'of' => self::ofExpression($match[1], $resolve, $where)];
        }
        if (isset(self::SCALARS[$expression])) {
            return ['k' => self::SCALARS[$expression]];
        }
        if (preg_match('/^\\\\?[A-Za-z_][A-Za-z0-9_\\\\]*$/', $expression) !== 1) {
            throw new PsxException(
                "{$where} says its data is \"{$expression}\", which is not a class, int, float, string, bool, list<T> or array<string, T>.",
            );
        }
        return self::ofClass($resolve($expression), $where, []);
    }

    /**
     * The shape of a native type.
     *
     * @param list<string> $within The classes being read, to refuse one that holds itself.
     * @return array<string, mixed>
     */
    public static function ofType(
        ?\ReflectionType $type,
        string $where,
        array $within = [],
        ?\Reflector $on = null,
    ): array {
        if (!$type instanceof \ReflectionNamedType) {
            throw new PsxException(
                "{$where} needs one plain type: an output's type says exactly what the page receives, so it cannot be "
                . ($type === null ? 'left out' : "\"{$type}\"")
                . '.',
            );
        }
        $name = $type->getName();
        $shape = match (true) {
            isset(self::SCALARS[$name]) => ['k' => self::SCALARS[$name]],
            $name === 'array' => self::ofArray($where, $within, $on),
            $name === 'mixed', $name === 'object', $name === 'iterable', $name === 'callable' => throw new PsxException(
                "{$where} is {$name}, which does not say what the page receives. Give it a class of its own, or a scalar.",
            ),
            default => self::ofClass($name, $where, $within),
        };
        return $type->allowsNull() && $shape['k'] !== 'null' ? ['k' => 'nullable', 'of' => $shape] : $shape;
    }

    /**
     * @param list<string> $within
     * @return array<string, mixed>
     */
    private static function ofArray(string $where, array $within, ?\Reflector $on): array
    {
        $attributes =
            $on instanceof \ReflectionProperty || $on instanceof \ReflectionParameter
                ? [...$on->getAttributes(ListOf::class), ...$on->getAttributes(MapOf::class)]
                : [];
        if (count($attributes) !== 1) {
            throw new PsxException(
                "{$where} is an array, which does not say what it holds. Mark it #[ListOf(Item::class)] for a list or #[MapOf(Item::class)] for a map by text keys.",
            );
        }
        $attribute = $attributes[0]->newInstance();
        if (!is_string($attribute->type)) {
            throw new PsxException(
                "{$where} describes its items' fields inline; an output's items are a class or a scalar.",
            );
        }
        $of = isset(self::SCALARS[$attribute->type])
            ? ['k' => self::SCALARS[$attribute->type]]
            : self::ofClass($attribute->type, $where, $within);
        return ['k' => $attribute instanceof ListOf ? 'list' : 'map', 'of' => $of];
    }

    /**
     * @param list<string> $within
     * @return array<string, mixed>
     */
    private static function ofClass(string $class, string $where, array $within): array
    {
        $class = ltrim($class, '\\');
        if ($class === \DateTimeImmutable::class || $class === \DateTimeInterface::class) {
            return ['k' => 'date'];
        }
        if (enum_exists($class)) {
            $enum = new \ReflectionEnum($class);
            if (!$enum->isBacked()) {
                throw new PsxException(
                    "{$where} is the enum {$class}, which has no backing values to send. Make it a backed enum.",
                );
            }
            foreach ($class::cases() as $case) {
                if (is_int($case->value) && abs($case->value) > self::SAFE) {
                    throw new PsxException(
                        "{$where} is the enum {$class}, whose case {$case->name} is {$case->value}: a whole number past 9007199254740991 either way, which a browser reads as another number. Back the enum with strings, or keep its values within that.",
                    );
                }
            }
            return [
                'k' => 'enum',
                'class' => $class,
                'values' => array_map(static fn(\BackedEnum $case): int|string => $case->value, $class::cases()),
            ];
        }
        if (!class_exists($class)) {
            throw new PsxException("{$where} is {$class}, and there is no such class.");
        }
        if (in_array($class, $within, true)) {
            throw new PsxException(
                "{$where} is {$class}, which holds itself. An output is a tree of plain values; send ids, and let the page ask for the rest.",
            );
        }
        $reflection = new \ReflectionClass($class);
        if ($reflection->isInternal() || $reflection->isAbstract() || $reflection->isInterface()) {
            throw new PsxException(
                "{$where} is {$class}, which is not a class of plain values. Declare a final readonly class with the fields the page needs.",
            );
        }
        $props = [];
        foreach ($reflection->getProperties(\ReflectionProperty::IS_PUBLIC) as $property) {
            if ($property->isStatic()) {
                continue;
            }
            if (!$property->isReadOnly()) {
                throw new PsxException(
                    "{$where} is {$class}, whose property \${$property->getName()} is not readonly. An output is a final readonly class of the fields the page needs, never a model or an entity.",
                );
            }
            $on = $property;
            if ($property->isPromoted()) {
                // The attributes of a promoted property are written on the constructor's parameter.
                foreach ($reflection->getConstructor()?->getParameters() ?? [] as $parameter) {
                    if ($parameter->getName() === $property->getName()) {
                        $on = $parameter;
                    }
                }
            }
            $props[$property->getName()] = self::ofType(
                $property->getType(),
                "{$class}::\${$property->getName()}",
                [...$within, $class],
                $on,
            );
        }
        return ['k' => 'object', 'class' => $class, 'name' => $reflection->getShortName(), 'props' => $props];
    }
}
