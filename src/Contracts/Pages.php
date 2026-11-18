<?php

declare(strict_types=1);

namespace Crab\Psx\Contracts;

use Crab\Contracts\Http\Middleware;

/**
 * Where an application says which .psx files are pages, layouts and
 * services, in a file PsxPlugin is given:
 *
 *     return static function (Pages $pages): void {
 *         $pages->layout('app', 'resources/layouts/App.psx');
 *         $pages->middleware(new CookieAuth(login: '/login'))->group(static function (Pages $pages): void {
 *             $pages->page('/posts/{id}', 'resources/pages/Posts/Edit.psx')->name('posts.edit')->layout('app');
 *             $pages->service('/people', 'resources/components/UserPicker.psx')->name('people');
 *         });
 *     };
 *
 * Nothing is found by where a file lies. A page is a family of routes:
 * its document, and one for each query and action of its own file and of
 * its layouts; the middleware of its groups, layouts and itself is around
 * every one of them.
 */
interface Pages
{
    /**
     * A page at a path, as a route's pattern: "/posts/{id}".
     */
    public function page(string $path, string $file): PageDeclaration;

    /**
     * A layout pages are put in by its name. It has no address of its own.
     */
    public function layout(string $name, string $file): LayoutDeclaration;

    /**
     * The queries and actions of a component's file, reached under a
     * path. It has no document.
     */
    public function service(string $path, string $file): ServiceDeclaration;

    public function prefix(string $prefix): PageGroup;

    /**
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public function middleware(Middleware|string ...$middleware): PageGroup;
}
