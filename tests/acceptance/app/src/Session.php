<?php

declare(strict_types=1);

namespace Acceptance;

use Crab\Contracts\Http\Request;
use Crab\Http\Cookie;
use Crab\Psx\AuthSnapshot;
use Crab\Psx\Contracts\AuthState;
use Psr\Http\Message\ServerRequestInterface;

/**
 * Who a browser is, by the application's own store: the AuthState PSX
 * is given, and what the guards read. A browser has a name of its own
 * in one cookie, kept across signing in and out, and a credential in
 * another.
 */
final readonly class Session implements AuthState
{
    public const string CONTEXT = 'acceptance_browser';
    public const string CREDENTIAL = 'acceptance_session';
    public const string ATTRIBUTE = 'acceptance.context';

    public function __construct(private Store $store) {}

    public function snapshot(Request $request): AuthSnapshot
    {
        $context = $this->context($request);
        $account = $this->account($request);
        return new AuthSnapshot(
            $context,
            (string) $this->store->revision($context),
            $account === null ? 'guest' : "user-{$account}",
        );
    }

    public function context(ServerRequestInterface $request): string
    {
        $named = $request->getAttribute(self::ATTRIBUTE) ?? $request->getCookieParams()[self::CONTEXT] ?? null;
        return is_string($named) && preg_match('/^[a-f0-9]{32}$/', $named) === 1 ? $named : 'none';
    }

    public function account(ServerRequestInterface $request): ?string
    {
        $token = $request->getCookieParams()[self::CREDENTIAL] ?? '';
        return $this->store->account($this->context($request), is_string($token) ? $token : '');
    }

    /**
     * Changes who is signed in, if the browser is still at the revision the page that asks saw,
     * which PSX sends with an #[Action(auth: true)]. Gives the cookie that goes with the change:
     * the new credential, or its removal. Null when the browser had moved on: nothing changed.
     */
    public function change(ServerRequestInterface $request, ?string $account): ?Cookie
    {
        $seen = $request->getHeaderLine('X-PSX-Auth-Revision');
        if (preg_match('/^\d{1,18}$/', $seen) !== 1) {
            return null;
        }
        [$changed, $token] = $this->store->change($this->context($request), (int) $seen, $account);
        return $changed ? new Cookie(self::CREDENTIAL, $token ?? '', $token === null ? 0 : 86_400) : null;
    }
}
