<?php

declare(strict_types=1);

return [
    'address' => env('SERVER_ADDRESS', 'tcp://127.0.0.1:8097'),
    'workers' => env('SERVER_WORKERS', 2),
    'watch' => ['src', 'app.php', 'config', 'routes', '.env'],
    // The largest body taken. The upload page takes a file of 128 KiB; the tests send more to see each limit.
    'max_body' => 256 * 1024,
];
