<?php

declare(strict_types=1);

use Acceptance\Browser;
use Acceptance\Csp;
use Crab\App;
use Crab\Psx\PsxPlugin;

// The application the acceptance tests drive in a real browser: pages that sign in and out without
// leaving, behind ordinary Crab guards, with an AuthState of its own kept in SQLite.
return App::configure(__DIR__)
    ->withPlugins([new PsxPlugin(routes: ['routes/pages.php'])])
    ->withMiddleware(append: [Browser::class, Csp::class])
    ->withRouting(routes: 'routes/web.php', health: '/up')
    ->create();
