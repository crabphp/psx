<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * What a page's or a layout's load() returns when it has more to say
 * than its data: the document's head, and the tags an action's
 * invalidate() refreshes it by. The method says what the data is in its
 * docblock, `@return PageData<EditData>`, since PHP has no generics.
 *
 * @template T
 */
final readonly class PageData
{
    /**
     * @param T $data
     * @param list<string> $tags
     */
    private function __construct(
        public mixed $data,
        public Head $head,
        public array $tags,
    ) {}

    /**
     * @template D
     * @param D $data
     * @return self<D>
     */
    public static function of(mixed $data): self
    {
        return new self($data, Head::none(), []);
    }

    /**
     * @return self<T>
     */
    public function head(Head $head): self
    {
        return new self($this->data, $head->over($this->head), $this->tags);
    }

    /**
     * @return self<T>
     */
    public function tags(string ...$tags): self
    {
        return new self($this->data, $this->head, Tags::merge($this->tags, $tags));
    }
}
