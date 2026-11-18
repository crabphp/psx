<?php

declare(strict_types=1);

use Crab\Contracts\Http\Errors;
use Crab\Psx\Contracts\Pages;
use Crab\Psx\Tests\Support\Guard;
use Psr\Container\ContainerInterface;

return static function (Pages $pages): void {
    $errors = Crab\App::current()->container->get(Errors::class);
    $pages->layout('app', 'resources/layouts/App.psx')
        ->middleware(new Guard('layout', $errors, open: true))
        ->operation('ping', new Guard('layout-ping', $errors, open: true));

    $pages->page('/', 'resources/pages/Home.psx')->name('home');

    $pages->middleware(new Guard('group', $errors))->group(static function (Pages $pages) use ($errors): void {
        $pages->page('/posts/{id}', 'resources/pages/Posts/Edit.psx')
            ->name('posts.edit')
            ->layout('app')
            ->middleware(new Guard('page', $errors, open: true))
            ->operation('savePost', new Guard('save', $errors));

        $pages->page('/posts', 'resources/pages/Posts/Index.psx')->name('posts.index')->layout('app');
    });

    $pages->service('/people', 'resources/components/People.psx')->name('people');
    $pages->service('/orgs/{org}/people', 'resources/components/People.psx')->name('orgPeople');
};
