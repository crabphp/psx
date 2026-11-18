<?php

declare(strict_types=1);

namespace Crab\Psx\Compiler;

/**
 * Whether one route may answer an address that is another's. Crab's
 * router answers with the first route declared, of those with a
 * parameter, that fits; so a query or an action declared after a route
 * that may fit its address is, for that address, never reached.
 *
 * It is decided by what can be proven of the two patterns, a segment
 * at a time, and never by trying addresses: a "no" here is a proof,
 * and whatever is not proven is a "yes".
 */
final class Addresses
{
    private const string PARAMETER = '/\{([A-Za-z_][A-Za-z0-9_]*)(?::((?:[^{}]++|\{[^{}]*\})+))?\}/';

    /**
     * An expression that is seen, by its spelling alone, to match no "/": letters, digits, "_",
     * "-", "\d", "\w", "\.", classes and ranges of those, groups, alternatives and counts. One
     * spelled any other way may be as narrow; it is not known to be.
     */
    private const string BOUNDED = '~^(?:[A-Za-z0-9_\-]|\\\\[dw.\-_]|\[(?!\^)-?(?:[a-z]-[a-z]|[A-Z]-[A-Z]|[0-9]-[0-9]|[A-Za-z0-9_.]|\\\\[dw.\-_])+-?\]|\(\?:|[()|+*?]|\{\d+(?:,\d*)?\})+$~D';

    /**
     * Whether a route declared earlier may answer an address of one declared later, for the
     * same method.
     */
    public static function shadows(string $earlier, string $later): bool
    {
        $first = self::segments($earlier);
        $second = self::segments($later);
        $spans = static function (array $segments): ?int {
            foreach ($segments as $index => $segment) {
                if ($segment['spans']) {
                    return $index;
                }
            }
            return null;
        };
        $a = $spans($first);
        $b = $spans($second);
        if ($a === null && $b === null) {
            if (count($first) !== count($second)) {
                // Neither takes a "/" anywhere: they answer addresses of their own number of segments.
                return false;
            }
            $until = count($first);
        } else {
            // From the first parameter that may take a "/", nothing is known of where segments fall.
            $until = min($a ?? PHP_INT_MAX, $b ?? PHP_INT_MAX);
            if (count($first) < $until || count($second) < $until) {
                return false;
            }
        }
        for ($index = 0; $index < $until; $index++) {
            if (!self::fits($first[$index], $second[$index])) {
                return false;
            }
        }
        // What follows the last such parameter of each is counted from the end: "/tree/{tail:.+}/view"
        // answers only what ends in "/view".
        for ($back = 1; $back <= min(count($first), count($second)); $back++) {
            $mine = $first[count($first) - $back];
            $theirs = $second[count($second) - $back];
            if ($mine['spans'] || $theirs['spans']) {
                break;
            }
            if (!self::fits($mine, $theirs)) {
                return false;
            }
        }
        return true;
    }

    /**
     * The first parameter of a pattern that is not known to stop at a "/", as it is written.
     */
    public static function spanning(string $pattern): ?string
    {
        preg_match_all(self::PARAMETER, $pattern, $matches, PREG_SET_ORDER);
        foreach ($matches as $match) {
            if (isset($match[2]) && !self::bounded($match[2])) {
                return $match[0];
            }
        }
        return null;
    }

    private static function bounded(string $expression): bool
    {
        return preg_match(self::BOUNDED, $expression) === 1;
    }

    /**
     * @return list<array{text: ?string, expression: string, spans: bool}> A pattern's segments: its
     *     text where it has no parameter, what it matches, and whether it may take a "/".
     */
    private static function segments(string $pattern): array
    {
        // A parameter's expression may hold a "/" of its own: it is set aside before the pattern is cut.
        $held = [];
        $cut = preg_replace_callback(
            self::PARAMETER,
            static function (array $match) use (&$held): string {
                $held[] = $match;
                return "\0" . (count($held) - 1) . "\0";
            },
            $pattern,
        );
        $segments = [];
        foreach (explode('/', (string) $cut) as $segment) {
            $parts = preg_split('/\0(\d+)\0/', $segment, -1, PREG_SPLIT_DELIM_CAPTURE) ?: [''];
            if (count($parts) === 1) {
                $segments[] = ['text' => $segment, 'expression' => preg_quote($segment, '~'), 'spans' => false];
                continue;
            }
            $expression = '';
            $spans = false;
            foreach ($parts as $index => $part) {
                if (($index % 2) === 0) {
                    $expression .= preg_quote($part, '~');
                    continue;
                }
                $own = $held[(int) $part][2] ?? null;
                if ($own === null) {
                    $expression .= '[^/]+';
                } elseif (self::bounded($own)) {
                    $expression .= '(?:' . $own . ')';
                } else {
                    $spans = true;
                }
            }
            $segments[] = ['text' => null, 'expression' => $expression, 'spans' => $spans];
        }
        return $segments;
    }

    /**
     * Whether a segment of the earlier route may be a segment of the later one's address. Proven
     * where either is text; two parameters may always meet.
     *
     * @param array{text: ?string, expression: string, spans: bool} $earlier
     * @param array{text: ?string, expression: string, spans: bool} $later
     */
    private static function fits(array $earlier, array $later): bool
    {
        if ($later['text'] !== null) {
            return @preg_match('~^(?:' . $earlier['expression'] . ')$~D', $later['text']) !== 0;
        }
        if ($earlier['text'] !== null) {
            return @preg_match('~^(?:' . $later['expression'] . ')$~D', $earlier['text']) !== 0;
        }
        return true;
    }
}
