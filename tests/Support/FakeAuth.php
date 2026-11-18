<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\Contracts\Http\Request;
use Crab\Psx\AuthSnapshot;
use Crab\Psx\Contracts\AuthState;

/**
 * An application's account of who a browser is, for a test to change
 * as a login in another tab would.
 */
final class FakeAuth implements AuthState
{
    public static string $revision = '3';
    public static string $partition = 'nobody';

    public function snapshot(Request $request): AuthSnapshot
    {
        return new AuthSnapshot('browser-1', self::$revision, self::$partition);
    }
}
