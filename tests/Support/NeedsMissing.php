<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\Contracts\Http\Request;
use Crab\Psx\AuthSnapshot;
use Crab\Psx\Contracts\AuthState;

/**
 * An AuthState that needs what no container can make.
 */
final class NeedsMissing implements AuthState
{
    public function __construct(\Crab\Psx\Tests\Support\Missing\Sessions $sessions) {}

    public function snapshot(Request $request): AuthSnapshot
    {
        return new AuthSnapshot('none', '0', 'none');
    }
}
