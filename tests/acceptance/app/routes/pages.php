<?php

declare(strict_types=1);

use Acceptance\Signed;
use Crab\Http\SameOrigin;
use Crab\Psx\Contracts\Pages;

return static function (Pages $pages): void {
    $pages->layout('shell', 'resources/layouts/Shell.psx');
    $pages->layout('tenant', 'resources/layouts/Tenant.psx');

    // Open to all; its sign-in is an action of the page, guarded by its origin.
    $pages->page('/login', 'resources/pages/Login.psx')->name('login')->operation('signIn', SameOrigin::class);

    $pages->middleware(Signed::class)->group(static function (Pages $pages): void {
        $pages->page('/', 'resources/pages/Home.psx')->name('home')->layout('shell');
        $pages->page('/other', 'resources/pages/Other.psx')->name('other')->layout('shell');
        $pages->page('/t/{tenant}', 'resources/pages/Tenant/Index.psx')->name('tenant.index')->layout('shell', 'tenant');
        $pages->page('/t/{tenant}/members', 'resources/pages/Tenant/Members.psx')
            ->name('tenant.members')
            ->layout('shell', 'tenant');
    });

    // Pages anyone may open, each for one kind of behaviour.
    $pages->page('/boxes', 'resources/pages/Boxes.psx')->name('boxes');
    $pages->service('/box/{box}', 'resources/components/Box.psx')->name('box');
    $pages->page('/forms', 'resources/pages/Forms.psx')->name('forms');
    $pages->page('/upload', 'resources/pages/Upload.psx')->name('upload');
    $pages->page('/lazy', 'resources/pages/Lazy.psx')->name('lazy');
    $pages->page('/long', 'resources/pages/Long.psx')->name('long');
    $pages->page('/fragile', 'resources/pages/Fragile.psx')->name('fragile');
};
