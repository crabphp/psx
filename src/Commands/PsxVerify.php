<?php

declare(strict_types=1);

namespace Crab\Psx\Commands;

use Crab\App;
use Crab\Contracts\Console\Command;
use Crab\Contracts\Console\Input;
use Crab\Contracts\Console\Output;
use Crab\Psx\Runtime\Kernel;

/**
 * Checks a release that is not yet selected, in a process that never
 * saw it compiled: by the time this runs, the application was defined
 * against it, which checked every signature and every address against
 * the application's own routes. What is left is what each Server class
 * is made with.
 */
final readonly class PsxVerify implements Command
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
        $problems = [];
        $seen = [];
        $families = $this->kernel->families ?? ['routes' => [], 'services' => []];
        $classes = [];
        foreach ($families['routes'] as $route) {
            foreach ($route['nodes'] as $node) {
                if ($node['class'] !== null) {
                    $classes[$node['class']] = $node['declaration']->file;
                }
            }
        }
        foreach ($families['services'] as $service) {
            foreach ($service['operations'] as $operation) {
                foreach ($operation['prepared']->dependencies() as $class) {
                    $classes[$class] = $service['file'];
                }
            }
        }
        foreach ($classes as $class => $file) {
            foreach (new \ReflectionClass($class)->getConstructor()?->getParameters() ?? [] as $parameter) {
                $type = $parameter->getType();
                $named = $type instanceof \ReflectionNamedType && !$type->isBuiltin() ? $type->getName() : null;
                if ($parameter->isDefaultValueAvailable() || $named !== null && $this->kernel->container->has($named)) {
                    continue;
                }
                $problem =
                    "{$file}: the Server class is made with \${$parameter->getName()}"
                    . (
                        $named === null
                            ? ', which is not a service. A Server class takes services; what a request carries is a method\'s argument.'
                            : ", a {$named}, which has no binding and is not a class that can be made."
                    );
                if (!isset($seen[$problem])) {
                    $seen[$problem] = true;
                    $problems[] = $problem;
                }
            }
        }
        // And what the application names for its container to make, as it is checked before it serves:
        // by reading, with nothing made. A Server class made with a service that needs what is not
        // there is found here, however deep.
        foreach (App::current()->unmade() as $problem) {
            if (!isset($seen[$problem])) {
                $seen[$problem] = true;
                $problems[] = $problem;
            }
        }
        foreach ($problems as $problem) {
            $output->error($problem);
        }
        return $problems === [] ? 0 : 1;
    }
}
