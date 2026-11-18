<?php

declare(strict_types=1);

namespace Crab\Psx\Runtime;

use Psr\Http\Message\ServerRequestInterface;

/**
 * The names of protocol psx/1, and what a request says of itself by them.
 *
 * @internal
 */
final class Protocol
{
    public const int VERSION = 1;
    public const string MEDIA = 'application/vnd.crab.psx+json';
    public const string PROTOCOL = 'X-PSX-Protocol';
    public const string BUILD = 'X-PSX-Build';
    public const string SCHEMA = 'X-PSX-Schema';
    public const string REVISION = 'X-PSX-Auth-Revision';

    /**
     * The key of what PSX keeps in a problem's context.
     */
    public const string CONTEXT = 'psx';

    /**
     * Whether a request speaks the protocol: it says so in a header, or
     * asks for the protocol's media type by name.
     */
    public static function spoken(ServerRequestInterface $request): bool
    {
        return $request->hasHeader(self::PROTOCOL) || self::quality($request, [self::MEDIA => 3]) > 0.0;
    }

    /**
     * Whether a request takes the protocol's media type in answer.
     */
    public static function accepted(ServerRequestInterface $request): bool
    {
        return (
            !$request->hasHeader('Accept')
            || self::quality($request, [self::MEDIA => 3, 'application/*' => 2, '*/*' => 1]) > 0.0
        );
    }

    /**
     * How much a request's Accept wants a media type, from 0 to 1: the
     * most specific range that names it decides, so that "q=0" on the
     * type refuses it whatever a wildcard says.
     *
     * @param array<string, int> $ranges The ranges that name the type, each with how specific it is.
     */
    public static function quality(ServerRequestInterface $request, array $ranges): float
    {
        $best = 0.0;
        $rank = 0;
        foreach (explode(',', $request->getHeaderLine('Accept')) as $range) {
            $parts = array_map(trim(...), explode(';', $range));
            $type = strtolower((string) array_shift($parts));
            $specific = $ranges[$type] ?? 0;
            if ($specific === 0) {
                continue;
            }
            $quality = 1.0;
            foreach ($parts as $part) {
                if (preg_match('/^q\s*=\s*([01](?:\.[0-9]{0,3})?)$/i', $part, $match) === 1) {
                    $quality = min(1.0, (float) $match[1]);
                }
            }
            if ($specific > $rank) {
                $rank = $specific;
                $best = $quality;
            }
        }
        return $best;
    }
}
