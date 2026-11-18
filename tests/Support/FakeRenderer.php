<?php

declare(strict_types=1);

namespace Crab\Psx\Tests\Support;

use Crab\Contracts\Container\Container;
use Crab\Contracts\Plugin;
use Crab\Http\HttpException;
use Crab\Psx\Contracts\RendererTransport;

/**
 * Stands where the JS renderer would: it keeps what it was asked to
 * render and answers with markup naming the page, or fails as a
 * renderer that is down does.
 */
final class FakeRenderer implements RendererTransport, Plugin
{
    /** @var list<array<string, mixed>> */
    public static array $asked = [];
    /** @var list<string|null> */
    public static array $nonces = [];
    public static bool $down = false;

    public function register(Container $container): void
    {
        $container->instance(RendererTransport::class, $this);
    }

    public function render(array $envelope, ?string $nonce = null): string
    {
        if (self::$down) {
            throw new HttpException(503, 'The page could not be rendered.');
        }
        self::$asked[] = $envelope;
        self::$nonces[] = $nonce;
        return '<main data-rendered="' . htmlspecialchars((string) $envelope['route']->id) . '">rendered</main>';
    }

    public function ready(): bool
    {
        return !self::$down;
    }
}
