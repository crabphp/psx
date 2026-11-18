# Final client consistency review of PSX DESIGN.md

Reviewed the proposed design, not an implementation. No framework/design edits or subagents. The design preserves real React behavior well, notably controlled drafts, immutable bindings, explicit JavaScript-only function forms, and unknown mutation outcomes. The following are remaining contract gaps/contradictions, ordered approximately by production impact.

## 1. Navigation-origin guards can invalidate their own navigation

**Sections:** 9, 11, 13–14. **Severity:** blocking.

`ifCurrent` must match at start and before commit, while the epoch changes with **every navigation intent**. A save initiated at epoch N calls `navigate(..., {ifCurrent: originN})`; that navigation itself advances to N+1, so a literal precommit check against originN rejects its own valid redirect. The same ambiguity affects a blocked attempt resumed through `proceed()`.

**Concrete fix:** specify a two-stage algorithm. Before starting, compare the supplied origin to the current committed-entry/intent snapshot. If it matches, allocate a new navigation transaction/generation. At commit, require **that transaction** still to be the latest permitted intent and retain its originating auth partition; do not compare the pre-navigation origin to the newly incremented global epoch. State explicitly how blocked/reset/resumed attempts allocate generations. Test valid save→redirect and save→redirect→newer navigation separately.

## 2. Auth epochs do not yet define ordering of auth-changing action responses

**Sections:** 13, 16–17. **Severity:** blocking for login/logout/account-switch integration.

Independent actions run concurrently and an `authChanged: true` response immediately increments the local epoch. The document also says old actions cannot affect a new epoch. It does not define what happens when two auth-changing actions complete out of order, or when a stale auth-changing response arrives after another tab/session transition. Blindly accepting its boolean can clear/install the wrong state; blindly ignoring it is insufficient because the browser can already have applied its `Set-Cookie` headers. An epoch stored only in JS cannot prove which principal current cookies represent.

**Concrete fix:** define an auth-transition state machine, not only a boolean side effect. Capture dispatch epoch on every request; prevent stale payload installation and cancel old navigation transactions. Specify server-side session/auth-transition ordering or a revision policy for overlapping identity-changing requests, and require authoritative reconciliation before protected UI is installed when an auth response has ambiguous/stale ordering. Document how the auth transition's own successful result/redirect is handled after advancing the epoch. Concurrent login/logout plus delayed response must be an acceptance case. Do not claim that client epoch checks alone control cookie ordering.

## 3. Query refusal and redirect handling have no representable public contract

**Sections:** 6, 10, 12, 14, 16. **Severity:** blocking.

Queries may return redirect control values and expected `PublicProblem`s, but the public callable is only `Promise<O>`. `QueryState.error` is `RequestFailure | null`, whose documented fields do not include the `PublicProblem` field/query/path errors, `loginUrl`, or a redirect target. The design promises typed failure/login-target handling without exposing those values through the query API. Expected query denials also risk becoming indistinguishable from unexpected transport failures and being reported as incidents.

**Concrete fix:** retain `Promise<O>` but define a separate expected `QueryRefusal`/`QueryRedirect` error type carrying the complete safe problem/control value, and make `QueryState.error` their union with `RequestFailure`; suppress incident reporting for the expected variants. Alternatively use a discriminated query result everywhere, updating examples and `useQuery` accordingly. Specify one choice and the query success/control wire envelopes. Queries must not navigate implicitly.

## 4. Generated action interfaces contradict form eligibility and file-only calls

**Sections:** 10, 15, 20. **Severity:** blocking type-contract mismatch.

The displayed `Action<I,O>` is always callable with a JSON object **and** always has `.form()`. The prose says `.form()` exists only for form-representable schemas, and file-bearing actions support `.form()` **only**. A compiler implementing the interface will advertise unsupported calls and allow files into a supposedly JSON-safe typed input; implementing the prose requires different generated types.

**Concrete fix:** define separate structural capabilities, for example `JsonAction<I,O>` (call signature), `FormAction<O>` (`form` method), and their intersection where both are legal. Scoped descriptors should return the generated capability type, rather than always `Action<I,O>`. File projections must not introduce a JSON call signature. Include compile-fail examples for calling a file-only action as a function and accessing `.form()` on a nonrepresentable schema.

## 5. Parameterized reusable services cannot be bound through a specified API

**Sections:** 7, 9–11. **Severity:** required public API missing.

Section 7 says a generated service reference creates a scope from explicit parameters, but never names or types this method. Section 11 defines only page route builders whose output is a navigation target. A branded `RouteScope` cannot legitimately be manufactured by user code, so a reusable service registered at `/organizations/{org}/people` has no specified way to call its generated scoped operations. A module with multiple service mounts also needs a deterministic mount-selection rule rather than an ambient route guess.

**Concrete fix:** add an exact generated service reference signature and example, such as `services.people.scope({org: '...'}): RouteScope<'people'>`, with `navigation: null`, canonical parameter encoding, and explicit selection of the named service mount. Keep service references distinct from navigable page targets. State whether a module mounted more than once remains descriptor-only even when each mount is pathless; it cannot silently select a guard chain.

## 6. Browser-only wrapper configuration can make the supported SSR mode unhydratable

**Sections:** 10, 19, 21. **Severity:** blocking when using the documented wrapper with SSR.

`start()` accepts an application wrapper `(children) => ReactNode` in the browser entry. SSR must render the identical React tree and provider context, but the renderer receives an envelope and release bundle with no specified shared wrapper entry. Executing `resources/entry.tsx` server-side is not valid: the example calls `document.getElementById`. Rendering without the wrapper can change markup, context-dependent text, IDs, and query configuration before hydration.

**Concrete fix:** introduce one shared application component/configuration module imported by both generated browser and SSR entries, with a precisely typed wrapper/provider contract. Keep DOM startup in a browser-only entry. Either disallow runtime-only wrapper overrides for server-rendered pages or require an explicitly matched renderer configuration. Specify that `clientOnly` renders the same fallback on SSR and the first hydration pass before loading the browser component.

## 7. The build's discovery/bootstrap order is circular on a clean checkout

**Sections:** 8, 21–23, 25. **Severity:** blocking tooling contract.

The definition phase loads the private manifest and validates prepared module signatures. The compiler discovers registered files by running that definition phase, but those PHP module definitions/manifests are outputs of compilation. Production correctly refuses a missing release, but the design does not distinguish a clean build/type-generation inspection mode from ordinary app definition. `psx:types`, an initial `psx:build`, or adding a new module cannot depend on yesterday's valid manifest to discover today's declarations.

**Concrete fix:** define a dedicated declaration-collection mode that invokes trusted registration closures without loading a selected release or resolving generated server classes. Collect paths/roles/mounts first, parse and generate PHP/schema/type artifacts in a scratch release, then run full ordinary definition validation against that candidate release before publication. State which service/dependency checks belong to each phase and make missing prior artifacts a supported initial state for build/check/types commands, never for production serving.

## 8. Unexpected HTTP redirects need an explicit non-following fetch policy

**Sections:** 13–14, 16–17. **Severity:** transport/security correctness gap.

The document correctly requires protocol redirects and says an unexpected middleware redirect becomes a controlled issue, but does not specify the browser transport's redirect mode. Fetch follows redirects by default. A 307/308 can automatically resend the mutation body to a different endpoint; a 302/303 can turn it into a login HTML request. This occurs before the client gets an opportunity to inspect content type and conflicts with the no-automatic-resubmission guarantee.

**Concrete fix:** mandate a non-following redirect mode for all generated protocol requests (`redirect: 'error'`, or `manual` with its browser opaque-redirect limitations explicitly handled). Only validated protocol control envelopes can direct subsequent navigation; they never resend an action. A post-send unexpected HTTP redirect is a sanitized transport failure with conservative mutation outcome, not a successful auth redirect. Test 302/303/307/308 from custom middleware and proxies.

## 9. Link-driven transport failures have no defined observable router state

**Sections:** 4, 10–11, 14. **Severity:** incomplete required navigation behavior.

Section 11 promises that a push/replace transport failure leaves the old page and **exposes a retryable navigation error**. `Router` has only `location` and `pending`; `NavigationResult` has no failure variant; `RouteError` is described for loader/HTTP failures, which commit the new route. A caller can catch an imperative `navigate` rejection, but a built-in `Link` has no documented channel for presenting the promised failure/retry UI. Merely clearing `pending` would make a click fail silently.

**Concrete fix:** expose a typed router navigation-error snapshot (attempted target, safe failure, retry/dismiss contract), or explicitly define a mounted navigation-error boundary/slot used by `Link`. Specify whether `navigate` rejects or returns a failed result and make `Link` consume that path without unhandled rejections. Retry creates a fresh safe navigation intent and obeys current blockers/auth/build state; it must not resurrect an obsolete attempt over a newer page.

## Summary

No React/PSX implementation or production test coverage is being claimed. Most remaining issues can be resolved by tightening a few types and state-machine rules rather than adding broad features. Resolve items 1–4 and 6–8 before implementation splits across compiler/router/transport teams; otherwise independently reasonable implementations will disagree at their boundaries.
