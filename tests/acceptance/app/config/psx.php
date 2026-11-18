<?php

declare(strict_types=1);

return [
    'rendering' => env('PSX_RENDERING', 'client'),
    'assets' => '/assets/psx/',
    // A component of the application's around every page: see resources/Wrapper.tsx.
    'wrapper' => 'resources/Wrapper.tsx',
    // The application's own account of who a browser is: see src/Session.php.
    'auth_state' => Acceptance\Session::class,
    // What runs the renderer: Node, unless a test puts something in its place that is slow to listen, or never does.
    'ssr' => ['node' => env('PSX_SSR_NODE', 'node')],
];
