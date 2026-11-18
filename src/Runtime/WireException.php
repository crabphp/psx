<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

/**
 * A value a loader, a query or an action returned is not what its type
 * says the page receives. It is a mistake in the application, never the
 * visitor's: the request fails, and nothing half-shaped is sent.
 */
final class WireException extends \LogicException {}
