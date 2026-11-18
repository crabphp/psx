<?php

declare(strict_types=1);

namespace Crab\Psx;

/**
 * An expected refusal a loader, a query or an action returns: what was
 * asked cannot be done, and the page is told why in words safe to show.
 * It is data, not an exception, and is not logged as a failure.
 *
 * An action returns one before it writes anything, or after rolling
 * back: PSX cannot undo what was already committed.
 */
final readonly class Failure
{
    private const array RESERVED = [
        'build_mismatch',
        'protocol',
        'unsupported_protocol',
        'not_acceptable',
        'unsupported_media_type',
        'auth_transition',
        'server_error',
    ];

    /**
     * @param array<string, list<string>> $fields
     */
    private function __construct(
        public int $status,
        public string $code,
        public string $message,
        public array $fields = [],
    ) {}

    /**
     * @param array<string, list<string>|string> $fields What is wrong, by field, as "lines.0.quantity".
     */
    public static function validation(array $fields, string $message = 'Check the highlighted fields.'): self
    {
        return new self(422, 'validation', $message, self::fields($fields));
    }

    public static function conflict(string $message = 'This was changed by someone else.'): self
    {
        return new self(409, 'conflict', $message);
    }

    public static function forbidden(string $message = 'You may not do this.'): self
    {
        return new self(403, 'forbidden', $message);
    }

    public static function notFound(string $message = 'Not found.'): self
    {
        return new self(404, 'not_found', $message);
    }

    /**
     * A refusal of the application's own.
     *
     * @param string $code Lowercase words joined by underscores: "quota_exceeded".
     * @param int $status From 400 to 499.
     * @param array<string, list<string>|string> $fields
     */
    public static function domain(string $code, string $message, int $status = 422, array $fields = []): self
    {
        if (preg_match('/^[a-z][a-z0-9_]{0,63}$/', $code) !== 1 || in_array($code, self::RESERVED, true)) {
            throw new \InvalidArgumentException(
                "A failure's code is lowercase words joined by underscores and none of the protocol's own, not \"{$code}\".",
            );
        }
        if ($status < 400 || $status > 499) {
            throw new \InvalidArgumentException(
                "A failure is a refusal, with a status from 400 to 499, not {$status}; what fails unexpectedly is thrown.",
            );
        }
        return new self($status, $code, $message, self::fields($fields));
    }

    /**
     * @param array<mixed> $fields
     * @return array<string, list<string>>
     */
    private static function fields(array $fields): array
    {
        $checked = [];
        foreach ($fields as $field => $problems) {
            $problems = is_string($problems) ? [$problems] : $problems;
            if (!is_string($field) || !is_array($problems) || array_filter($problems, is_string(...)) !== $problems) {
                throw new \InvalidArgumentException(
                    'A failure\'s fields are messages by field name: [\'title\' => [\'is required\']].',
                );
            }
            $checked[$field] = array_values($problems);
        }
        return $checked;
    }
}
