<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * Marks a parameter of a .psx function as a service the application's
 * container gives, not something the request carries:
 *
 *     #[Action]
 *     function savePost(int $id, SavePost $input, #[Inject] Posts $posts): PostDetail
 *
 * Only load() and the functions marked #[Query] or #[Action] take them. The
 * service is made once for each worker and shared by its requests, as a
 * constructor's would be: it keeps nothing of one request for the next.
 */
#[\Attribute(\Attribute::TARGET_PARAMETER)]
final readonly class Inject {}
