<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\Contracts\Http\Request;
use Crab\Psx\AuthSnapshot;
use Crab\Psx\Contracts\AuthState;

/**
 * An AuthState that writes down each time one is made, and by which
 * process, and needs a service of the application's to be made at all.
 */
final class CountingAuth implements AuthState
{
    /**
     * @var list<int> The process that made each.
     */
    public static array $made = [];
    public static string $revision = '3';
    public static string $partition = 'user-1';

    public function __construct(Posts $posts)
    {
        self::$made[] = getmypid();
    }

    public function snapshot(Request $request): AuthSnapshot
    {
        return new AuthSnapshot('browser-1', self::$revision, self::$partition);
    }
}
