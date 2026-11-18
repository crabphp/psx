<?php

declare(strict_types=1);

namespace Crab\Psx\Compiler;

use Crab\Psx\PsxException;

/**
 * Writes TypeScript from what was read: the type of an output from its
 * shape, and the type of an input from the schema Crab validates it by.
 * A type is never widened to "any": what cannot be said is refused when
 * its shape is read.
 *
 * @internal
 */
final class TypeWriter
{
    /**
     * The interfaces written so far, by name.
     *
     * @var array<string, string>
     */
    private array $interfaces = [];

    /**
     * The name each class was given.
     *
     * @var array<string, string>
     */
    private array $names = [];

    /**
     * @param list<string> $reserved The names the module's own types take.
     */
    public function __construct(
        private array $reserved = [],
    ) {}

    /**
     * The type of an output.
     *
     * @param array<string, mixed> $shape
     */
    public function output(array $shape): string
    {
        return match ($shape['k']) {
            'string', 'date' => 'string',
            'int', 'float' => 'number',
            'bool' => 'boolean',
            'null' => 'null',
            'enum' => implode(' | ', array_map(self::literal(...), $shape['values'])) ?: 'never',
            'list' => 'readonly ' . self::grouped($this->output($shape['of'])) . '[]',
            'map' => 'Readonly<Record<string, ' . $this->output($shape['of']) . '>>',
            'nullable' => $this->output($shape['of']) . ' | null',
            'object' => $this->named($shape),
            default => throw new PsxException("The shape \"{$shape['k']}\" is not one PSX writes."),
        };
    }

    /**
     * The type of an input, from its JSON Schema.
     *
     * @param array<string, mixed>|null $schema
     */
    public function input(?array $schema, string $indent = ''): string
    {
        if ($schema === null) {
            return 'Record<string, never>';
        }
        $types = (array) ($schema['type'] ?? []);
        $nullable = in_array('null', $types, true);
        $types = array_values(array_diff($types, ['null']));
        if (isset($schema['enum'])) {
            $type = implode(' | ', array_map(self::literal(...), $schema['enum'])) ?: 'never';
        } elseif ($types === ['object'] || isset($schema['properties'])) {
            $type = $this->fields($schema, $indent);
        } elseif ($types === ['array'] && isset($schema['items'])) {
            $type = self::grouped($this->input($schema['items'], $indent)) . '[]';
        } elseif ($types === ['string'] && ($schema['format'] ?? null) === 'binary') {
            $type = 'File';
        } else {
            $type = implode(
                ' | ',
                array_unique(array_map(
                    static fn(string $type): string => match ($type) {
                        'integer', 'number' => 'number',
                        'string' => 'string',
                        'boolean' => 'boolean',
                        default => 'JsonValue',
                    },
                    $types === [] ? ['any'] : $types,
                )),
            );
        }
        return $nullable ? "{$type} | null" : $type;
    }

    /**
     * The interfaces the types written so far name.
     */
    public function interfaces(): string
    {
        return implode("\n", $this->interfaces);
    }

    /**
     * Whether an input type names JsonValue, which is then imported.
     */
    public static function literal(int|string|float|bool|null $value): string
    {
        return json_encode($value, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    /**
     * A property's name as TypeScript writes it.
     */
    public static function key(string $name): string
    {
        return preg_match('/^[A-Za-z_$][A-Za-z0-9_$]*$/', $name) === 1 ? $name : self::literal($name);
    }

    /**
     * @param array<string, mixed> $schema
     */
    private function fields(array $schema, string $indent): string
    {
        $properties = (array) ($schema['properties'] ?? []);
        if ($properties === []) {
            return 'Record<string, never>';
        }
        $required = (array) ($schema['required'] ?? []);
        $lines = [];
        foreach ($properties as $name => $property) {
            $property = (array) $property;
            $optional = !in_array($name, $required, true) || array_key_exists('default', $property);
            $lines[] =
                "{$indent}    "
                . self::key((string) $name)
                . ($optional ? '?' : '')
                . ': '
                . $this->input($property, $indent . '    ')
                . ';';
        }
        return "{\n" . implode("\n", $lines) . "\n{$indent}}";
    }

    /**
     * @param array<string, mixed> $shape
     */
    private function named(array $shape): string
    {
        $class = $shape['class'];
        if (isset($this->names[$class])) {
            return $this->names[$class];
        }
        $name = preg_replace('/[^A-Za-z0-9_]/', '_', $shape['name']) ?: 'Value';
        $taken = [...$this->reserved, ...array_values($this->names)];
        for ($suffix = 2, $base = $name; in_array($name, $taken, true); ++$suffix) {
            $name = "{$base}_{$suffix}";
        }
        $this->names[$class] = $name;
        $lines = [];
        foreach ($shape['props'] as $property => $of) {
            $lines[] = '    readonly ' . self::key($property) . ': ' . $this->output($of) . ';';
        }
        $this->interfaces[$name] =
            "export interface {$name} {\n" . implode("\n", $lines) . ($lines === [] ? '' : "\n") . "}\n";
        return $name;
    }

    private static function grouped(string $type): string
    {
        return str_contains($type, '|') || str_starts_with($type, 'readonly ') ? "({$type})" : $type;
    }
}
