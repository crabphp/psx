<?php

declare(strict_types=1);

namespace Crab\Psx\Testing;

use PHPUnit\Framework\Assert;
use Psr\Http\Message\ResponseInterface;

/**
 * What a page, a query or an action answered a test, read as the
 * page's runtime would read it.
 */
final readonly class PsxResponse
{
    /**
     * The decoded envelope; null where the answer is not the protocol's, such as a document.
     *
     * @var array<string, mixed>|null
     */
    public ?array $envelope;

    public function __construct(
        public ResponseInterface $response,
    ) {
        $decoded = str_starts_with($response->getHeaderLine('Content-Type'), 'application/vnd.crab.psx+json')
            ? json_decode((string) $response->getBody(), true)
            : null;
        $this->envelope = is_array($decoded) ? $decoded : null;
    }

    public function status(): int
    {
        return $this->response->getStatusCode();
    }

    /**
     * "page", "query", "action", "problem" or "redirect"; null for what is not the protocol's.
     */
    public function kind(): ?string
    {
        return $this->envelope['kind'] ?? null;
    }

    /**
     * A query's or an action's data, or one loader's by its place in the chain.
     */
    public function data(?int $node = null): mixed
    {
        return $node === null ? $this->envelope['data'] ?? null : $this->envelope['nodes'][$node]['data'] ?? null;
    }

    /**
     * The public problem of a refusal or a failure.
     *
     * @return array<string, mixed>|null
     */
    public function problem(): ?array
    {
        return $this->envelope['problem'] ?? null;
    }

    /**
     * Whether the method was entered, as a refusal or a failure says: "entered" or "not-entered".
     */
    public function execution(): ?string
    {
        return $this->envelope['execution'] ?? null;
    }

    /**
     * Whether a problem is one the pages wrote on purpose, a refusal
     * before the method or a Failure the method returned, and so says
     * that nothing was kept. False for anything else that followed the
     * method's entry: what it did is then not known.
     */
    public function expected(): ?bool
    {
        return $this->envelope['expected'] ?? null;
    }

    /**
     * The bootstrap a document carries for the page to start from.
     *
     * @return array<string, mixed>|null
     */
    public function bootstrap(): ?array
    {
        if (
            preg_match(
                '~<script type="application/json" id="psx-bootstrap">(.*?)</script>~s',
                (string) $this->response->getBody(),
                $match,
            ) !== 1
        ) {
            return null;
        }
        return json_decode($match[1], true);
    }

    public function assertOk(): static
    {
        Assert::assertSame(
            200,
            $this->status(),
            'The answer was: ' . substr((string) $this->response->getBody(), 0, 600),
        );
        return $this;
    }

    public function assertProblem(int $status, ?string $code = null, ?string $execution = null): static
    {
        Assert::assertSame(
            $status,
            $this->status(),
            'The answer was: ' . substr((string) $this->response->getBody(), 0, 600),
        );
        Assert::assertSame('problem', $this->kind());
        if ($code !== null) {
            Assert::assertSame($code, $this->problem()['code'] ?? null);
        }
        if ($execution !== null) {
            Assert::assertSame($execution, $this->execution());
        }
        return $this;
    }
}
