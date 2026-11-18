<?php

declare(strict_types=1);

// Compiles a fixture application in a process of its own and says its build: php compile.php <folder> <namespace>

use Crab\Psx\Tests\Support\FixtureApp;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

echo new FixtureApp($argv[1], $argv[2])->compile()['build'], "\n";
