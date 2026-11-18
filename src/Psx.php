<?php

declare(strict_types=1);

namespace Crab\Psx;

use Crab\App;
use Crab\Contracts\Http\Middleware;
use Crab\Psx\Contracts\LayoutDeclaration;
use Crab\Psx\Contracts\PageDeclaration;
use Crab\Psx\Contracts\PageGroup;
use Crab\Psx\Contracts\Pages;
use Crab\Psx\Contracts\ServiceDeclaration;

/**
 * Declares pages on the current application's Pages registry, for route
 * files, beside Crab's own Route:
 *
 *     Route::post('/login', Login::class);
 *
 *     Psx::layout('app', 'App');
 *     Psx::page('/counter', 'Counter');
 *     Psx::middleware(CookieAuth::class)->group(function () {
 *         Psx::page('/posts/{id}', 'Posts/Edit')->name('posts.edit')->layout('app');
 *     });
 *
 * A file is named by a path ending in ".psx", or by its name in the
 * folder of its kind inside "psx.resources": pages/, layouts/ or
 * components/ for a service. PsxPlugin must be among the plugins.
 */
final class Psx
{
    /**
     * A page at a path, as a route's pattern: "/posts/{id}".
     */
    public static function page(string $path, string $file): PageDeclaration
    {
        return self::pages()->page($path, $file);
    }

    /**
     * A layout pages are put in by its name.
     */
    public static function layout(string $name, string $file): LayoutDeclaration
    {
        return self::pages()->layout($name, $file);
    }

    /**
     * The queries and actions of a component's file, reached under a path.
     */
    public static function service(string $path, string $file): ServiceDeclaration
    {
        return self::pages()->service($path, $file);
    }

    public static function prefix(string $prefix): PageGroup
    {
        return self::pages()->prefix($prefix);
    }

    /**
     * @param Middleware|class-string<Middleware> ...$middleware
     */
    public static function middleware(Middleware|string ...$middleware): PageGroup
    {
        return self::pages()->middleware(...$middleware);
    }

    private static function pages(): Pages
    {
        $container = App::current()->container;
        if (!$container->has(Pages::class)) {
            throw new PsxException(
                'Psx:: declares pages on PsxPlugin\'s registry, and the application has no PsxPlugin: add it with ->withPlugins([new PsxPlugin()]).',
            );
        }
        $pages = $container->get(Pages::class);
        if (!$pages instanceof Pages) {
            throw new PsxException('The container holds something other than PsxPlugin\'s registry under Pages.');
        }
        return $pages;
    }
}
