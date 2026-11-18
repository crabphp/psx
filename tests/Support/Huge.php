<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

/**
 * An enum PHP allows and no page may be sent: two of its cases are one
 * number in JavaScript.
 */
enum Huge: int
{
    case Small = 1;
    case Edge = 9_007_199_254_740_991;
    case Over = 9_007_199_254_740_992;
    case Next = 9_007_199_254_740_993;
    case Under = -9_007_199_254_740_992;
}
