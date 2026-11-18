<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

use Crab\Contracts\Http\Request;
use Crab\Psx\AuthSnapshot;

/**
 * The application's own account of who a browser is, for pages that log
 * in and out without leaving: bound as "psx.auth_state", and needed only
 * by an #[Action(auth: true)]. It reads the application's real auth
 * store; PSX keeps no users.
 *
 * The application's login and logout raise the revision as one step with
 * issuing or revoking the credential, and its middleware refuses a
 * credential of an older revision, so that two tabs cannot leave a
 * browser logged in as someone the page no longer shows.
 */
interface AuthState
{
    /**
     * Who the request's browser is now, by its current credentials.
     */
    public function snapshot(Request $request): AuthSnapshot;
}
