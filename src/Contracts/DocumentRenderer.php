<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

use Crab\Psx\Runtime\Document;

/**
 * Writes a page's HTML document from values already prepared: it runs no
 * loader, looks for no user and fetches nothing. Bind another to change
 * the shell, such as one that renders it with Arc.
 */
interface DocumentRenderer
{
    public function render(Document $document): string;
}
