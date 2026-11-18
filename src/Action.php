<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * Marks a function of a .psx file as a mutation the page may call:
 * the compiler gives the TSX below a binding of the same name, $savePost
 * for savePost(). It takes the path's parameters, one typed body, and the
 * request, user or session; it is reached by POST and never retried.
 */
#[\Attribute(\Attribute::TARGET_METHOD | \Attribute::TARGET_FUNCTION)]
final readonly class Action
{
    /**
     * @param bool $auth Whether it logs someone in or out. Such an action needs the application's AuthState
     *     adapter, "psx.auth_state", and the page is reconciled with the new identity after it.
     */
    public function __construct(
        public bool $auth = false,
    ) {}
}
