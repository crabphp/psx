<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

/**
 * The posts the fixture pages read and change: a service a Server class
 * is constructed with, as an application's own would be.
 */
final class Posts
{
    /**
     * @var array<int, array{title: string, version: int}>
     */
    public array $posts = [7 => ['title' => 'Seven', 'version' => 3], 8 => ['title' => 'Eight', 'version' => 1]];

    /**
     * What ran, in order: a loader, a query or an action, by name.
     *
     * @var list<string>
     */
    public array $ran = [];
}
