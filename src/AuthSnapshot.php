<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * Who a browser is to the page's caches, as the application's AuthState
 * says: none of it is a credential, and the page is given it only to
 * keep one identity's data apart from another's.
 */
final readonly class AuthSnapshot
{
    /**
     * @param string $context An opaque name for this browser, the same before and after logging in.
     * @param string $revision A whole number as text that grows with every login and logout of that browser.
     * @param string $partition An opaque name for whose data this is: one per user, and one for nobody.
     */
    public function __construct(
        public string $context,
        public string $revision,
        public string $partition,
    ) {
        if (preg_match('/^(?:0|[1-9][0-9]{0,39})$/', $revision) !== 1) {
            throw new \InvalidArgumentException("An auth revision is a whole number as text, not \"{$revision}\".");
        }
        foreach (['context' => $context, 'partition' => $partition] as $name => $value) {
            if (preg_match('/^[A-Za-z0-9._:-]{1,128}$/', $value) !== 1) {
                throw new \InvalidArgumentException(
                    "An auth snapshot's {$name} is up to 128 letters, digits, . _ : and -.",
                );
            }
        }
    }

    /**
     * @return array{context: string, revision: string, partition: string}
     */
    public function toArray(): array
    {
        return ['context' => $this->context, 'revision' => $this->revision, 'partition' => $this->partition];
    }
}
