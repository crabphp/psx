<?php

declare(strict_types=1);

namespace Crab\Psx\Commands;

use Crab\Contracts\Console\Command;
use Crab\Contracts\Console\Input;
use Crab\Contracts\Console\Output;
use Crab\Psx\PsxException;
use Crab\Psx\Runtime\Kernel;

/**
 * Writes the TSX, types and bindings an editor and a CI check read,
 * without building a release.
 */
final readonly class PsxTypes implements Command
{
    public function __construct(
        private Kernel $kernel,
    ) {}

    public function description(): string
    {
        return 'Write the types and bindings the TSX is checked against';
    }

    public function handle(Input $input, Output $output): int
    {
        $stage = sys_get_temp_dir() . '/psx-types-' . bin2hex(random_bytes(6));
        try {
            $manifest = $this->kernel->compiler()->compile($this->kernel->registry, $stage);
        } catch (PsxException $refused) {
            $output->error($refused->getMessage());
            return 1;
        } finally {
            PsxCompile::remove($stage);
        }
        $output->line(
            count($manifest['modules'])
            . ' files compiled; their types are in '
            . $this->kernel->config('client')
            . '/types.',
        );
        return 0;
    }
}
