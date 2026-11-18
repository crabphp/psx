<?php

declare(strict_types=1);

use Crab\Http\HttpException;
use Crab\Route;

// Ordinary Crab routes beside the pages.
Route::get('/plain', static fn(): array => ['plain' => true]);
Route::post('/plain', static fn(): array => ['posted' => true]);
Route::get('/plain/missing', static function (): never {
    throw new HttpException(404, 'No such plain thing.');
});
