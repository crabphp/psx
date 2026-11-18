<?php

declare(strict_types=1);

use Crab\Route;

Route::get('/plain', static fn(): array => ['plain' => true]);
