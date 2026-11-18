<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * Says what an array property of an output holds when it is a map from
 * text to values, as #[ListOf] does for a list: #[MapOf('int')] array
 * $counts is {"drafts": 3} to the page.
 */
#[\Attribute(\Attribute::TARGET_PROPERTY | \Attribute::TARGET_PARAMETER)]
final readonly class MapOf
{
    /**
     * @param string $type A class, an enum, or int, float, string or bool.
     */
    public function __construct(
        public string $type,
    ) {}
}
