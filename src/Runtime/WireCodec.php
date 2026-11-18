<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

/**
 * Turns what a method returned into what is sent, by the shape its type
 * declared: only the declared fields of declared classes, each checked.
 * Nothing is sent by walking an object's own idea of itself, so a model
 * or a jsonSerialize() never decides what the browser sees.
 *
 * @internal
 */
final readonly class WireCodec
{
    private const int SAFE = 9_007_199_254_740_991;

    public function __construct(
        private int $maxDepth = 32,
        private int $maxItems = 10_000,
    ) {}

    /**
     * @param array<string, mixed> $shape
     * @param string $where What returned the value, for a message.
     */
    public function encode(array $shape, mixed $value, string $where): mixed
    {
        return $this->value($shape, $value, $where, 0);
    }

    /**
     * @param array<string, mixed> $shape
     */
    private function value(array $shape, mixed $value, string $path, int $depth): mixed
    {
        if ($depth > $this->maxDepth) {
            throw new WireException("{$path} is nested deeper than {$this->maxDepth}, \"psx.max_depth\".");
        }
        switch ($shape['k']) {
            case 'nullable':
                return $value === null ? null : $this->value($shape['of'], $value, $path, $depth);
            case 'null':
                if ($value !== null) {
                    throw self::not($path, 'nothing', $value);
                }
                return null;
            case 'string':
                if (!is_string($value)) {
                    throw self::not($path, 'a string', $value);
                }
                if (!mb_check_encoding($value, 'UTF-8')) {
                    throw new WireException(
                        "{$path} is not UTF-8 text. Send bytes through a download route, or encode them.",
                    );
                }
                return $value;
            case 'int':
                if (!is_int($value)) {
                    throw self::not($path, 'an int', $value);
                }
                if ($value > self::SAFE || $value < -self::SAFE) {
                    throw new WireException(
                        "{$path} is {$value}, which JavaScript cannot hold exactly. Declare it a string for an id or a decimal this large.",
                    );
                }
                return $value;
            case 'float':
                if (!is_float($value) && !is_int($value)) {
                    throw self::not($path, 'a float', $value);
                }
                if (!is_finite((float) $value)) {
                    throw new WireException("{$path} is not a finite number, and JSON has no other.");
                }
                return $value;
            case 'bool':
                if (!is_bool($value)) {
                    throw self::not($path, 'a bool', $value);
                }
                return $value;
            case 'date':
                if (!$value instanceof \DateTimeInterface) {
                    throw self::not($path, 'a date', $value);
                }
                return $value->format('Y-m-d\TH:i:s.vP');
            case 'enum':
                if (!$value instanceof \BackedEnum || !$value instanceof $shape['class']) {
                    throw self::not($path, "a {$shape['class']}", $value);
                }
                if (is_int($value->value) && ($value->value > self::SAFE || $value->value < -self::SAFE)) {
                    // The compiler refuses such a case; a value that reaches here anyway is not sent.
                    throw new WireException(
                        "{$path} is the enum value {$value->value}, which JavaScript cannot hold exactly.",
                    );
                }
                return $value->value;
            case 'list':
                if (!is_array($value) || !array_is_list($value)) {
                    throw self::not($path, 'a list, with keys 0, 1, 2 and so on', $value);
                }
                $this->bounded($value, $path);
                $items = [];
                foreach ($value as $index => $item) {
                    $items[] = $this->value($shape['of'], $item, "{$path}[{$index}]", $depth + 1);
                }
                return $items;
            case 'map':
                if (!is_array($value)) {
                    throw self::not($path, 'a map by text keys', $value);
                }
                $this->bounded($value, $path);
                $map = new \stdClass();
                foreach ($value as $key => $item) {
                    if (!is_string($key)) {
                        throw new WireException(
                            "{$path} is a map by text keys, and has the key {$key}. Declare a list, or key it by text.",
                        );
                    }
                    $map->{$key} = $this->value($shape['of'], $item, "{$path}[{$key}]", $depth + 1);
                }
                return $map;
            case 'object':
                if (!$value instanceof $shape['class']) {
                    throw self::not($path, "a {$shape['class']}", $value);
                }
                $object = new \stdClass();
                foreach ($shape['props'] as $name => $of) {
                    $object->{$name} = $this->value($of, $value->{$name}, "{$path}.{$name}", $depth + 1);
                }
                return $object;
        }
        throw new WireException("{$path} has a shape \"{$shape['k']}\" this release does not know.");
    }

    /**
     * @param array<mixed> $value
     */
    private function bounded(array $value, string $path): void
    {
        if (count($value) > $this->maxItems) {
            throw new WireException(
                "{$path} holds "
                . count($value)
                . " items, over the {$this->maxItems} of \"psx.max_collection_items\". Send a page of them.",
            );
        }
    }

    private static function not(string $path, string $expected, mixed $value): WireException
    {
        return new WireException("{$path} is declared {$expected}, and returned " . get_debug_type($value) . '.');
    }
}
