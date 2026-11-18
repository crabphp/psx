<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

/**
 * Runs the programs a build is made of: PHP again for a fresh look at
 * what was compiled, and the JavaScript tools the project installed.
 *
 * @internal
 */
final class Shell
{
    /**
     * Runs a program to its end, with this terminal as its own.
     *
     * @param list<string> $command
     * @param array<string, string> $environment Added to this process's.
     */
    public static function run(array $command, string $directory, array $environment = []): int
    {
        $process = proc_open(
            $command,
            [0 => STDIN, 1 => STDOUT, 2 => STDERR],
            $pipes,
            $directory,
            [...getenv(), ...$environment],
        );
        return $process === false ? 127 : proc_close($process);
    }

    /**
     * Runs a program to its end and gives what it wrote.
     *
     * @param list<string> $command
     * @param array<string, string> $environment
     * @return array{int, string} Its status, and its output and errors together.
     */
    public static function capture(array $command, string $directory, array $environment = []): array
    {
        $process = proc_open(
            $command,
            [0 => ['file', '/dev/null', 'r'], 1 => ['pipe', 'w'], 2 => ['redirect', 1]],
            $pipes,
            $directory,
            [...getenv(), ...$environment],
        );
        if ($process === false) {
            return [127, "{$command[0]} could not be started."];
        }
        $output = (string) stream_get_contents($pipes[1]);
        fclose($pipes[1]);
        return [proc_close($process), trim($output)];
    }

    /**
     * The command that runs this application's console again.
     *
     * @return list<string>
     */
    public static function cua(string $base, string ...$arguments): array
    {
        return [PHP_BINARY, "{$base}/cua", ...$arguments];
    }

    /**
     * A tool the project installed with npm, or null when it has not.
     */
    public static function tool(string $base, string $name): ?string
    {
        $path = "{$base}/node_modules/.bin/{$name}";
        return is_file($path) ? $path : null;
    }
}
