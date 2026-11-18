<?php

declare(strict_types=1);

namespace Crab\Psx\Commands;

use Crab\Contracts\Console\Command;
use Crab\Contracts\Console\Input;
use Crab\Contracts\Console\Output;
use Crab\Psx\PsxException;
use Crab\Psx\Runtime\Kernel;
use Crab\Psx\Runtime\Shell;

/**
 * Checks the pages without building a release: compiles them, defines
 * the application against what was compiled in a process that never saw
 * it compiled, and has TypeScript check the TSX against the types the
 * PHP gave. Any failure is a status other than 0.
 */
final readonly class PsxCheck implements Command
{
    public function __construct(
        private Kernel $kernel,
    ) {}

    public function description(): string
    {
        return 'Check the pages, their types and their declarations';
    }

    public function handle(Input $input, Output $output): int
    {
        $base = $this->kernel->base;
        $stage = sys_get_temp_dir() . '/psx-check-' . bin2hex(random_bytes(6));
        try {
            try {
                $manifest = $this->kernel->compiler()->compile($this->kernel->registry, $stage);
            } catch (PsxException $refused) {
                $output->error($refused->getMessage());
                return 1;
            }
            $output->line(count($manifest['modules']) . ' files compiled.');
            [$status, $said] = Shell::capture(Shell::cua($base, 'psx:verify', "--release={$stage}"), $base);
            if ($status !== 0) {
                $output->error($said === '' ? 'The compiled pages could not be defined.' : $said);
                return 1;
            }
            $output->line('The application is defined against them: signatures, guards and addresses agree.');
        } finally {
            PsxCompile::remove($stage);
        }
        $tsc = Shell::tool($base, 'tsc');
        if ($tsc === null) {
            $output->error('TypeScript is not installed, so the TSX was not checked. Run `npm install`.');
            return 1;
        }
        if (Shell::run([$tsc, '--noEmit', '-p', 'tsconfig.json'], $base) !== 0) {
            $output->error('TypeScript found problems in the TSX.');
            return 1;
        }
        $output->line('TypeScript checked the TSX against the types the PHP declares.');
        return 0;
    }
}
