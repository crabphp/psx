<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Crab\Contracts\Development;
use Crab\Psx\PsxException;

/**
 * What `php cua dev` does for the pages: compile them before each
 * server it starts, in a process of its own; start a server anew only
 * when their PHP changed; and run Vite beside it, which the first
 * server waits for.
 *
 * @internal
 */
final class DevelopmentSteps
{
    public static function register(Development $development, Kernel $kernel): void
    {
        $client = $kernel->path(trim((string) $kernel->config('client'), '/'));
        $hot = "{$client}/hot";
        $current = $kernel->developmentRoot() . '/current';
        // What a run that was killed left behind says nothing of this one.
        @unlink($hot);
        $development->watch(trim((string) $kernel->config('resources'), '/'), 'psx');
        $development->prepare('psx', static function (?array $changed) use ($kernel, $current): bool {
            $before = is_link($current) ? readlink($current) : null;
            [$status, $output] = Shell::capture(Shell::cua($kernel->base, 'psx:compile'), $kernel->base);
            if ($status !== 0) {
                throw new PsxException($output === '' ? 'The pages could not be compiled.' : $output);
            }
            // Only the pages' PHP starts a server anew; their TSX is Vite's to refresh.
            return $changed === null || $before !== (is_link($current) ? readlink($current) : null);
        });
        $development->started('psx', static function () use ($client, $current): void {
            // Vite's plugin reloads the pages open in a browser when the server they talk to is another.
            @file_put_contents(
                "{$client}/generation",
                (is_link($current) ? basename((string) readlink($current)) : '') . ' ' . hrtime(true),
            );
        });
        if (Shell::tool($kernel->base, 'vite') === null) {
            throw new PsxException('Vite is not installed. Run `npm install` in the application first.');
        }
        $environment = [
            'PSX_DEV' => '1',
            'PSX_RESOURCES' => trim((string) $kernel->config('resources'), '/'),
            'PSX_CLIENT' => trim((string) $kernel->config('client'), '/'),
            'PSX_ENTRY' => (string) $kernel->config('entry'),
            // Development's renderer is Vite itself: a page is rendered with the code it hydrates with.
            'PSX_SSR_SOCKET' => $kernel->socket('dev'),
        ];
        $development->process(
            'vite',
            implode(' ', array_map(
                static fn(string $name, string $value): string => $name . '=' . escapeshellarg($value),
                array_keys($environment),
                $environment,
            ))
                . ' exec node_modules/.bin/vite',
            static fn(): bool => is_file($hot),
        );
    }
}
