<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * The names loaders and queries are tagged with and actions invalidate:
 * "posts", "post:42".
 *
 * @internal
 */
final class Tags
{
    /**
     * @param list<string> $tags
     * @param array<string> $more
     * @return list<string>
     */
    public static function merge(array $tags, array $more): array
    {
        foreach ($more as $tag) {
            if (preg_match('/^[A-Za-z0-9:._\/-]{1,128}$/', $tag) !== 1) {
                throw new \InvalidArgumentException(
                    "A tag is up to 128 letters, digits, : . _ / and -, such as \"post:42\", not \"{$tag}\".",
                );
            }
        }
        return array_values(array_unique([...$tags, ...$more]));
    }
}
