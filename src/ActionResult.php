<?php

declare(strict_types=1);

namespace Crab\Psx;

use Crab\Http\Cookie;

/**
 * What an #[Action] method returns when it has more to say than its
 * data: an expected failure, the tags to refresh, a redirect for the
 * caller to follow, a cookie. `@return ActionResult<SavedPost>` says what
 * the data of a success is.
 *
 * @template T
 */
final readonly class ActionResult
{
    /**
     * @param T|null $data
     * @param list<string> $invalidate
     * @param list<Cookie> $cookies
     */
    private function __construct(
        public mixed $data,
        public ?Failure $failure,
        public array $invalidate = [],
        public ?Redirect $redirect = null,
        public bool $authChanged = false,
        public array $cookies = [],
    ) {}

    /**
     * @template D
     * @param D $data
     * @return self<D>
     */
    public static function ok(mixed $data = null): self
    {
        return new self($data, null);
    }

    /**
     * @return self<never>
     */
    public static function fail(Failure $failure): self
    {
        return new self(null, $failure);
    }

    /**
     * The tags whose loaders and queries the page refreshes. Call it once
     * the application's transaction has committed.
     *
     * @return self<T>
     */
    public function invalidate(string ...$tags): self
    {
        $this->successful('invalidate');
        return new self(
            $this->data,
            null,
            Tags::merge($this->invalidate, $tags),
            $this->redirect,
            $this->authChanged,
            $this->cookies,
        );
    }

    /**
     * Where the caller may go next. It is data for the page: nothing
     * navigates by itself.
     *
     * @return self<T>
     */
    public function redirect(Redirect $redirect): self
    {
        $this->successful('redirect');
        return new self($this->data, null, $this->invalidate, $redirect, $this->authChanged, $this->cookies);
    }

    /**
     * Says that who is logged in changed; only an #[Action(auth: true)] may.
     *
     * @return self<T>
     */
    public function authChanged(): self
    {
        $this->successful('authChanged');
        return new self($this->data, null, $this->invalidate, $this->redirect, true, $this->cookies);
    }

    /**
     * A cookie the response sets, as logging in and out do. It is a
     * header of the response, never part of its data.
     *
     * @return self<T>
     */
    public function cookie(Cookie $cookie): self
    {
        return new self($this->data, $this->failure, $this->invalidate, $this->redirect, $this->authChanged, [
            ...$this->cookies,
            $cookie,
        ]);
    }

    private function successful(string $method): void
    {
        if ($this->failure !== null) {
            throw new \LogicException("ActionResult::{$method}() is for a success; a failure changed nothing.");
        }
    }
}
