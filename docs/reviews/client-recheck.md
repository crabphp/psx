# Client design recheck

Re-read the revised relevant sections of `psx/DESIGN.md`. This is a design-consistency review, not implementation verification.

## Resolved

All nine findings from `client-final.md` are resolved at design level:

1. **Navigation guards (§11):** the supplied origin is checked before allocating a transaction; commit checks the new transaction. Blocked/resumed/reset intents and refreshed origin snapshots now have defined behavior.
2. **Auth transitions (§10, §17):** ordinary CookieAuth document authentication remains the default. Optional in-app transitions require a revisioned application adapter, server-side ordering, reconciliation barriers, stale-response handling, and a fresh post-reconciliation navigation origin. JavaScript epochs no longer claim to control cookie ordering.
3. **Query controls (§10, §12, §16):** `QueryProblem` and `QueryRedirect` carry expected control outcomes; `QueryState.error` exposes the same union. Success remains `Promise<O>` and queries do not navigate implicitly.
4. **Action capabilities (§10):** generated JSON-callable, form-capable, and form-only types now agree with supported encodings, including uploads.
5. **Service scopes (§7):** the explicit `services.<name>.scope(params)` constructor and multiply mounted service rule remove ambiguous mount selection.
6. **SSR wrapper (§10, §19):** both entries import the shared configured wrapper; browser DOM startup stays separate. `clientOnly` has matching SSR/initial-hydration fallback behavior. The local private-socket deployment boundary is explicit.
7. **Cold builds (§21):** declaration collection needs no prior release; staged artifacts are validated in a fresh definition process before publication. Serve mode still requires a complete release.
8. **HTTP redirects (§16):** generated fetches explicitly refuse HTTP redirects, preventing implicit 307/308 mutation replay. Typed control envelopes govern subsequent navigation.
9. **Navigation failures (§11):** observable `navigationError`, failed results, Link handling, and guarded retry/dismiss behavior provide the previously missing UI contract.

The stable cross-build refusal layer, explicit query/control envelopes, composite loader schemas, and strict-decoding requirements are also consistent with these changes; they are described as proposed contracts and prerequisites rather than existing functionality.

## Remaining blocking contradictions

**None found in the rechecked client contracts.** No additional optional features or implementation proof are requested by this review.
