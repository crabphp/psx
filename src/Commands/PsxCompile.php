<?php

declare(strict_types=1);

namespace Crab\Psx\Commands;

use Crab\Contracts\Console\Command;
use Crab\Contracts\Console\Input;
use Crab\Contracts\Console\Output;
use Crab\Psx\Compiler\Compiler;
use Crab\Psx\PsxException;
use Crab\Psx\Runtime\Kernel;
use Crab\Psx\Runtime\Shell;

/**
 * Compiles the pages for `php cua dev`, which runs it in a process of
 * its own before each server it starts. What it compiled is selected
 * only once it is whole and a process that never saw it compiled has
 * defined the application against it: a page that does not compile, an
 * address an ordinary route already has, or a Server class made with
 * what nothing can make, leaves the last one, the server that runs it
 * and the scripts the browser was given for it.
 */
final readonly class PsxCompile implements Command
{
    public function __construct(
        private Kernel $kernel,
    ) {}

    public function description(): string
    {
        return '';
    }

    public function handle(Input $input, Output $output): int
    {
        $root = $this->kernel->developmentRoot();
        $stage = "{$root}/stage-" . bin2hex(random_bytes(4));
        $compiler = $this->kernel->compiler();
        try {
            // What the browser's build reads stays in the stage until the stage is found fit to serve.
            $manifest = $compiler->compile($this->kernel->registry, $stage, publish: false);
        } catch (PsxException $refused) {
            self::remove($stage);
            $output->error($refused->getMessage());
            return 1;
        }
        [$status, $said] = Shell::capture(
            Shell::cua($this->kernel->base, 'psx:verify', "--release={$stage}"),
            $this->kernel->base,
        );
        if ($status !== 0) {
            self::remove($stage);
            $output->error($said === '' ? 'The compiled pages could not be defined.' : $said);
            return 1;
        }
        $final = "{$root}/{$manifest['build']}";
        if (is_dir($final)) {
            // The same PHP as one already there: only what the browser reads may differ.
            self::remove("{$final}/" . Compiler::BROWSER);
            rename("{$stage}/" . Compiler::BROWSER, "{$final}/" . Compiler::BROWSER);
            self::remove($stage);
        } else {
            rename($stage, $final);
        }
        $compiler->publish($final);
        $link = "{$root}/current";
        $before = is_link($link) ? readlink($link) : null;
        if ($before !== $manifest['build']) {
            $next = "{$link}." . bin2hex(random_bytes(4));
            symlink((string) $manifest['build'], $next);
            rename($next, $link);
        }
        // The one a server still running was started from is kept beside the new one.
        foreach (glob("{$root}/*", GLOB_ONLYDIR) ?: [] as $directory) {
            if (!in_array(basename($directory), [$manifest['build'], $before], true)) {
                self::remove($directory);
            }
        }
        $output->line((string) $manifest['build']);
        return 0;
    }

    public static function remove(string $directory): void
    {
        if (!is_dir($directory) || is_link($directory)) {
            return;
        }
        Compiler::fresh($directory);
        @rmdir($directory);
    }
}
