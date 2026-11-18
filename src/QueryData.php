<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * What a #[Query] method returns when its result has tags an action's
 * invalidate() refreshes it by; `@return QueryData<SearchResults>` says
 * what the data is.
 *
 * @template T
 */
final readonly class QueryData
{
    /**
     * @param T $data
     * @param list<string> $tags
     */
    private function __construct(
        public mixed $data,
        public array $tags,
    ) {}

    /**
     * @template D
     * @param D $data
     * @return self<D>
     */
    public static function of(mixed $data): self
    {
        return new self($data, []);
    }

    /**
     * @return self<T>
     */
    public function tags(string ...$tags): self
    {
        return new self($this->data, Tags::merge($this->tags, $tags));
    }
}
