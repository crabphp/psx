<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * Marks a method of a .psx Server class as a read the page may call: the
 * compiler gives the TSX below a binding of the same name, $searchPeople
 * for searchPeople(). It takes the path's parameters and query fields
 * marked #[FromQuery], is reached by GET, and must change nothing.
 */
#[\Attribute(\Attribute::TARGET_METHOD)]
final readonly class Query {}
