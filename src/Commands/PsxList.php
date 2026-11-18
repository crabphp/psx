<?php

declare(strict_types=1);

namespace Crab\Psx\Commands;

use Crab\Contracts\Console\Command;
use Crab\Contracts\Console\Input;
use Crab\Contracts\Console\Output;
use Crab\Contracts\Routing\Actions;
use Crab\Psx\Compiler\Families;
use Crab\Psx\PsxException;
use Crab\Psx\Runtime\Kernel;

/**
 * Lists what the pages files declare: each page with its layouts, its
 * guards in the order they run, and the address of each of its queries
 * and actions.
 */
final readonly class PsxList implements Command
{
    public function __construct(
        private Kernel $kernel,
    ) {}

    public function description(): string
    {
        return 'List the pages, their layouts, queries and actions';
    }

    public function handle(Input $input, Output $output): int
    {
        $stage = sys_get_temp_dir() . '/psx-list-' . bin2hex(random_bytes(6));
        try {
            $manifest = $this->kernel->compiler()->compile($this->kernel->registry, $stage);
            $families = Families::build(
                $this->kernel->registry,
                $manifest['modules'],
                $this->kernel->container->get(Actions::class),
            );
        } catch (PsxException $refused) {
            $output->error($refused->getMessage());
            return 1;
        } finally {
            PsxCompile::remove($stage);
        }
        $guards = static fn(array $middleware): string => $middleware === []
            ? 'no guards'
            : implode(' > ', array_map(static fn(mixed $layer): string => is_string($layer)
                ? $layer
                : $layer::class, $middleware));
        foreach ($families['routes'] as $name => $route) {
            $output->line("page {$name}  GET {$route['path']}  {$route['file']}");
            $layouts = array_filter(array_column($route['nodes'], 'layout'));
            $output->line('    layouts: ' . ($layouts === [] ? 'none' : implode(' > ', $layouts)));
            $output->line('    guards: ' . $guards($route['middleware']));
            $output->line(
                "    schema: {$route['schema']}  query: " . (implode(', ', array_keys($route['query'])) ?: 'none'),
            );
            self::operations($output, $route['operations'], $guards);
        }
        foreach ($families['services'] as $name => $service) {
            $output->line("service {$name}  {$service['path']}  {$service['file']}");
            $output->line('    guards: ' . $guards($service['middleware']));
            self::operations($output, $service['operations'], $guards);
        }
        if ($families['routes'] === [] && $families['services'] === []) {
            $output->line('No page is declared. `php cua psx:init` writes a first one.');
        }
        return 0;
    }

    /**
     * @param array<string, array<string, mixed>> $operations
     * @param \Closure(list<mixed>): string $guards
     */
    private static function operations(Output $output, array $operations, \Closure $guards): void
    {
        $rows = [];
        foreach ($operations as $operation) {
            $rows[] = [
                $operation['role'],
                $operation['method'] . '()',
                ($operation['role'] === 'query' ? 'GET ' : 'POST ') . $operation['pattern'],
                $operation['name'],
                "{$operation['file']}:{$operation['line']}",
                $guards($operation['middleware']),
            ];
        }
        if ($rows !== []) {
            $output->table($rows, '    ');
        }
    }
}
