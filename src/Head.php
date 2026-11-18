<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * What a page puts in the document's head: its title, description,
 * canonical address and further meta and link tags, each under a key so
 * that an inner page's replaces an outer layout's. An immutable value:
 * every method returns another.
 *
 *     Head::title('Edit post')->description('Change a post.')
 */
final readonly class Head
{
    private const array META = ['name', 'property', 'content', 'http-equiv'];
    private const array LINK = ['rel', 'href', 'type', 'sizes', 'media', 'hreflang', 'title'];

    /**
     * @param array<string, array<string, string>> $meta By key.
     * @param array<string, array<string, string>> $links By key.
     */
    private function __construct(
        public ?string $title = null,
        public array $meta = [],
        public array $links = [],
    ) {}

    public static function title(string $title): self
    {
        return new self()->withTitle($title);
    }

    public static function description(string $description): self
    {
        return new self()->withDescription($description);
    }

    public static function canonical(string $url): self
    {
        return new self()->withCanonical($url);
    }

    /**
     * @param array<string, string> $attributes
     */
    public static function meta(string $key, array $attributes): self
    {
        return new self()->withMeta($key, $attributes);
    }

    /**
     * @param array<string, string> $attributes
     */
    public static function link(string $key, array $attributes): self
    {
        return new self()->withLink($key, $attributes);
    }

    public function withTitle(string $title): self
    {
        return new self($title, $this->meta, $this->links);
    }

    public function withDescription(string $description): self
    {
        return $this->withMeta('description', ['name' => 'description', 'content' => $description]);
    }

    /**
     * @param string $url An https or http address, from the application's own settings and never from the request's Host.
     */
    public function withCanonical(string $url): self
    {
        return $this->withLink('canonical', ['rel' => 'canonical', 'href' => $url]);
    }

    /**
     * @param array<string, string> $attributes Of name, property, content and http-equiv.
     */
    public function withMeta(string $key, array $attributes): self
    {
        self::check('meta', $key, $attributes, self::META);
        if (strtolower($attributes['http-equiv'] ?? '') === 'refresh') {
            throw new \InvalidArgumentException('A page redirects with Redirect, not with a refresh meta tag.');
        }
        return new self($this->title, [...$this->meta, $key => $attributes], $this->links);
    }

    /**
     * @param array<string, string> $attributes Of rel, href, type, sizes, media, hreflang and title.
     */
    public function withLink(string $key, array $attributes): self
    {
        self::check('link', $key, $attributes, self::LINK);
        $href = $attributes['href'] ?? '';
        if (preg_match('~^(?:https?://|/(?!/))~i', $href) !== 1) {
            throw new \InvalidArgumentException(
                "A link's href is an http(s) address or a path of this site, not \"{$href}\".",
            );
        }
        if (preg_match('/\b(?:stylesheet|preload|modulepreload|prefetch|import)\b/i', $attributes['rel'] ?? '') === 1) {
            throw new \InvalidArgumentException(
                'A page\'s styles and scripts are imported in its TSX, where the build finds them; Head links are for canonical, alternate, icon and the like.',
            );
        }
        return new self($this->title, $this->meta, [...$this->links, $key => $attributes]);
    }

    /**
     * This head over an outer one: the nearest title and each key win.
     */
    public function over(self $outer): self
    {
        return new self(
            $this->title ?? $outer->title,
            [...$outer->meta, ...$this->meta],
            [
                ...$outer->links,
                ...$this->links,
            ],
        );
    }

    public static function none(): self
    {
        return new self();
    }

    /**
     * @return array{title: string|null, meta: array<string, array<string, string>>, links: array<string, array<string, string>>}
     */
    public function toArray(): array
    {
        return ['title' => $this->title, 'meta' => $this->meta, 'links' => $this->links];
    }

    /**
     * @param array<mixed> $attributes
     * @param list<string> $allowed
     */
    private static function check(string $tag, string $key, array $attributes, array $allowed): void
    {
        if (preg_match('/^[A-Za-z0-9:._-]{1,64}$/', $key) !== 1) {
            throw new \InvalidArgumentException("A {$tag} tag's key is letters, digits, : . _ and -, not \"{$key}\".");
        }
        foreach ($attributes as $name => $value) {
            if (!in_array($name, $allowed, true) || !is_string($value) || strlen($value) > 2048) {
                throw new \InvalidArgumentException(
                    "A {$tag} tag takes " . implode(', ', $allowed) . ' as text; "' . $name . '" is not one of them.',
                );
            }
        }
    }
}
