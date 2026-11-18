<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * A mistake in a .psx file, a declaration or a build, said with where it
 * is and what to do instead.
 */
final class PsxException extends \LogicException
{
    /**
     * @param string|null $source The file the mistake is in, relative to the application.
     * @param int|null $sourceLine Its line there.
     */
    public function __construct(
        string $message,
        public readonly ?string $source = null,
        public readonly ?int $sourceLine = null,
        ?\Throwable $previous = null,
    ) {
        $where = $source === null ? '' : $source . ($sourceLine === null ? '' : ":{$sourceLine}") . ': ';
        parent::__construct($where . $message, previous: $previous);
    }
}
