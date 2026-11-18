<?php

declare(strict_types=1);

namespace Acceptance;

use Crab\Engine\Async\Async;
use Crab\Engine\EventLoop;

/**
 * Lets a test hold a request at a named place until it says go, so
 * that two requests overlap in an order the test chose and not in one
 * a timer happened to give. The test makes storage/gates/<name>.hold;
 * a request that reaches the place writes <name>.arrived and waits,
 * giving the worker to other requests, until the file is gone.
 */
final readonly class Gate
{
    public function pass(string $place, string $who = ''): void
    {
        $folder = storage_path('gates');
        foreach (array_unique(["{$place}.{$who}", $place]) as $name) {
            $hold = "{$folder}/{$name}.hold";
            if (!is_file($hold)) {
                continue;
            }
            file_put_contents("{$folder}/{$name}.arrived", getmypid() . "\n", FILE_APPEND | LOCK_EX);
            $until = microtime(true) + 30;
            while (is_file($hold)) {
                if (microtime(true) > $until) {
                    throw new \RuntimeException("The gate {$name} was never opened.");
                }
                clearstatcache(true, $hold);
                Async::sleep(EventLoop::current(), 0.01);
            }
            file_put_contents("{$folder}/{$name}.passed", getmypid() . "\n", FILE_APPEND | LOCK_EX);
        }
    }
}
