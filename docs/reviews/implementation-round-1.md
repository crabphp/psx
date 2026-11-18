# PSX implementation review — round 1

**Result: not accepted against the complete design.** This independent initial review confirms 19 actionable findings: 8 High and 11 Medium. The highest-impact failures are published PHP source, incorrect mutation-outcome guarantees, invalid input entering actions, stale identity adoption, and navigation/auth races. Passing happy-path suites do not close these acceptance gates.

Review date: 2026-11-15. Scope: actual package `/home/daudau/Code/crabphp/psx`, framework integration and surrounding paths, and authored demo code. Production files were not edited; only these reports and isolated `/tmp` reproductions were written. No subagents, commits, pushes, releases, deployment, or running-demo/database changes. The build reproduction publishes only into its disposable `/tmp` app.

The initial source attribution is `/tmp/psx-review-baseline-6gjmw6zu` (package/demo authored snapshots and framework diff/untracked files). The client fix batch began while the remaining audit continued; the C findings below describe the **pre-fix** source preserved in that snapshot and scratch compiled `dist/`. This document does not certify the later client fixes. Those receive a separate `implementation-round-2-client.md` review.

## Finding index

| ID | Severity | Finding |
| --- | --- | --- |
| R1-C01 | High | Stale guarded document navigation bypasses origin checks/blockers |
| R1-C02 | High | Navigation origins survive replace/settled intent generations |
| R1-C03 | High | Auth reconciliation allows writes and stale page commits |
| R1-C04 | High | Older auth snapshots can reinstall a prior principal |
| R1-C05 | Medium | Overlapping revalidations commit in completion order |
| R1-C06 | Medium | Abort/resubscribe leaves a query pending forever |
| R1-C07 | Medium | Invalidation fetches disabled queries |
| R1-S01 | High | Mutation execution/expected-failure provenance is untruthful |
| R1-S02 | High | Strict inputs collapse JSON shape and accept unsafe integers |
| R1-S03 | Medium | Documents skip strict PSX query decoding |
| R1-S04 | High | Stale/unsupported protocol writes can reach ordinary dispatch |
| R1-S05 | Medium | Unmarked authChanged bypasses the declared auth contract |
| R1-S06 | Medium | Definition constructs worker services in the parent |
| R1-S07 | Medium | Documents ignore HTML Accept negotiation |
| R1-B01 | High | Vite asset URLs publish encoded PHP; release scanner misses it |
| R1-B02 | Medium | Development selects generations fresh validation rejects |
| R1-B03 | Medium | SSR timeout accounting permits excess unresolved render work |
| R1-B04 | Medium | Catch-all pages intercept their generated queries |
| R1-B05 | Medium | Distinct module paths collide as PHP namespaces |

Fixes should preserve the stable IDs. The early batch handoffs remain in `implementation-round-1-client.md`, `implementation-round-1-server.md`, and `implementation-round-1-build.md`. Detailed evidence is consolidated below so this report stands on its own.

## R1-C01 — High: document navigation bypasses stale-origin checks and blockers

**Location:** `js/src/router.ts:259-271`, especially the early `leave()` at 262–265.

**Trigger:** Capture page A's `scope.navigation`, navigate to page B, install a blocker, then let A's delayed action call `navigate('/ordinary-login', {ifCurrent: oldOrigin})`. The target is a same-origin ordinary route outside the PSX route table. External HTTP(S) targets take the same branch.

**Observed:** Resolves `status: 'document'` and calls the document-navigation function, despite both the stale origin and the blocker. Repro prints `stale ifCurrent + blocker bypass: document http://localhost/ordinary-login`.

**Expected / contract:** Design §§9, 11, 13: `ifCurrent` is checked before any navigation side effect; a late save from A cannot redirect B. Owned imperative navigation must honor applicable dirty-navigation blocking before leaving the document.

**Impact:** An otherwise correctly guarded delayed save/login redirect can discard a newer editor's draft.

**Narrow fix / regression:** Run origin checks and the intent/blocker lifecycle before either SPA or document navigation. Test stale and current origins for ordinary and external targets; a current blocked document target must not leave until explicitly proceeded.

## R1-C02 — High: navigation origins do not identify the navigation that created them

**Location:** `js/src/router.ts:248`, `259-271`, `354-368`, `753-759`; `js/src/types.ts: NavigationOrigin`.

**Trigger:** Capture A's origin; `navigate('/two', {replace:true})`; then a delayed A callback calls `navigate('/three', {ifCurrent: oldOrigin})`.

**Observed:** The old callback commits `/three`. Replacement kept the entry key, and `origin.epoch` is only the auth epoch. `current()` has no navigation generation to distinguish A from the replaced page. Similarly, a held/settled intent does not invalidate old callbacks: `abandon()` changes a generation that no origin carries.

**Expected / contract:** Design §11 explicitly requires comparing the current entry/**intent** snapshot, superseding old origins when a new intent is allocated, and publishing fresh origins after settling/resetting an attempt. A guarded navigation's own newly allocated generation must remain valid.

**Impact:** The documented late-action protection fails for replacement navigation and held/failed intents, even on PSX routes.

**Narrow fix / regression:** Track a navigation-intent version independently of auth identity; include/associate it with immutable origins, invalidate old versions on every intent, and republish the active page's scopes at settlement. Test replace A→B, blocked/reset navigation, and a valid current-origin redirect that does not cancel itself.

## R1-C03 — High: the auth reconciliation barrier permits writes and stale reconciliation commits

**Location:** `js/src/runtime.ts:256-267`, `297-319`, `338-351`; `js/src/router.ts:380-419`.

**Trigger / observed:** Call `runtime.authChanged()` and hold its reconciliation GET pending. A saved action binding can immediately send a POST: `transitioning` is false, while only the router's `reconciling` flag is set. Repro confirms one POST succeeds while `reconciling=true`. During the same barrier, navigate to `/two`, then finish the earlier `/one` reconciliation read. Reconcile checks only auth epoch, not its captured navigation generation; it overwrites the page with `/one` while location remains `/two`.

**Expected / contract:** Design §17: writes during an identity transition must wait or receive an explicit refusal; reconciliation may install only for the barrier's latest generation. Clearing private UI alone is insufficient. Committed auth success must remain success even if reconciliation fails.

**Impact:** Old callbacks can mutate using changing credentials. Concurrent navigation can expose a page/scope inconsistent with the URL after the barrier, including operations targeting the wrong displayed resource.

**Narrow fix / regression:** Use one explicit barrier state consulted by all write dispatches, retaining it through reconciliation/document-required state. Reconciliation must own a navigation generation and check it before changing page, auth, or head. Define whether navigation supersedes or waits for the barrier. Test a held GET with attempted POST, a second auth transition, newer navigation, timeout, and successful auth mutation followed by failed reconciliation.

## R1-C04 — High: an older server auth revision can reinstall the previous principal

**Location:** `js/src/router.ts:970`, `978-990`; related `380-419`; `js/src/runtime.ts:189-210`, `269-309`.

**Trigger:** Start with authoritative snapshot `{context:'ctx', revision:'5', partition:'new-user'}`. Answer a navigation with a valid same-build page carrying `{context:'ctx', revision:'4', partition:'old-user'}` and old private data. Such ordering can arise with a delayed response/prefetch across credential transitions; responses must be checked independently of local completion order.

**Observed:** Navigation commits the old data and changes `runtime.auth` to revision 4 / old-user. `adopt()` assigns before any revision comparison; the only numeric comparison is on the special reconciliation path. Query/action response snapshots are not checked at all. The confirmed repro is the navigation case.

**Expected / contract:** Design §17: authoritative monotonic server revisions and partitions govern data installation; an older answer is discarded even when it completes last. Missing/invalid snapshots during adapter-enabled reconciliation cannot establish identity.

**Impact:** The optional in-app auth mechanism can roll the UI/cache partition back to a prior user. A cache clear followed by adopting that old page does not make its data current.

**Narrow fix / regression:** Centralize validated AuthSnapshot comparison for every response/cache installation, compare decimal revisions numerically within the proper context, and reconcile ambiguous changes. Do not overwrite the known snapshot first. Add delayed lower-revision page/query responses, prefetched old pages, changed contexts, missing snapshots, and delayed auth responses/cookies to browser/transport tests. Client checks complement the adapter's required server-side CAS/revision enforcement; they cannot undo browser Set-Cookie order.

## R1-C05 — Medium: concurrent loader revalidations commit in completion order

**Location:** `js/src/router.ts:274-302`.

**Trigger:** Start revalidation A, then B on the same page. Resolve B with newer data, then A with older data.

**Observed:** Final displayed data/head is A's older value (`overlapping revalidation final data: older`). Both reads captured the same generation/entry/auth epoch because revalidation never allocates its own read version.

**Expected / contract:** Design §§11–13: later reads/invalidation must not be overwritten by older responses; successful mutations schedule safe refreshes without making a successful write look failed.

**Impact:** Rapid saves or explicit refreshes can make a just-updated page visibly revert. Route-change checks alone do not order reads of the same route.

**Narrow fix / regression:** Give loader refreshes a version that invalidation/revalidation advances, or serialize/coalesce them with a trailing fresh read. Keep route/auth generation checks too. Test two refreshes resolved in reverse order and overlapping successful mutations whose refreshes return out of order.

## R1-C06 — Medium: immediate query resubscription inherits an aborted request and never restarts

**Location:** `js/src/queries.ts:85-106`, `110-119`, `149-166`.

**Trigger:** Subscribe to an uncached query; unsubscribe its last listener (aborts transport); immediately resubscribe before the abort rejection settles. Then let the abort settle.

**Observed:** The second subscription sees `fetching=true`, so starts nothing. The rejected request clears fetching, but does not restart for the now-present listener. Final state is `pending`, `isFetching=false`, with exactly one aborted request and no data/error. This lifecycle is also relevant to React StrictMode's subscription setup/cleanup replay.

**Expected / contract:** Design §12 expressly permits canceling an unused request only if later resubscription remains correct. Enabled subscribed queries must make progress.

**Impact:** A mounted component can remain blank/pending indefinitely until an unrelated refetch or remount.

**Narrow fix / regression:** Detach/invalidate the canceled promise on last unsubscribe or schedule a new request for active enabled listeners after its cancellation settles. Old completion must not clear/install over the replacement. Test immediate and delayed resubscribe, StrictMode, and cancellation of one of multiple subscribers.

## R1-C07 — Medium: invalidation fetches disabled queries

**Location:** `js/src/queries.ts:85-94`, `173-187`.

**Trigger:** Subscribe with `{enabled:false}` to an uncached query, then call `queries.invalidate()` (a previously tagged disabled entry is also reachable through action tag invalidation).

**Observed:** One network request is sent. Invalidation checks listener count only; it does not retain subscribers' enabled status.

**Expected / contract:** Design §12: a disabled uncached query stays pending and is not fetching. `enabled` commonly guards incomplete inputs or a component that is not ready to load.

**Impact:** Invalidation can run queries with missing/invalid inputs and unexpectedly reveal error/loading states or perform expensive reads that the component disabled.

**Narrow fix / regression:** Track enabled subscriptions separately from mere listeners. Mark disabled entries stale without fetching; fetch when an enabled subscriber is present or on explicit `refetch()`. Test all-disabled, mixed enabled/disabled, and toggling enabled after invalidation.


## R1-S01 — High — Execution and expected-failure provenance can misrepresent a committed mutation

**Locations:** `psx/src/Runtime/Responder.php:164-196` (particularly 168 and 182-183); `psx/src/Runtime/OperationHandler.php:46`; `framework/src/Routing/ActionHandler.php:240-251`; `framework/src/Http/RenderedErrors.php:35-44`; corresponding client classification at `psx/js/src/protocol.ts:158-189` and `js/src/runtime.ts`'s action problem branch.

**Triggers and observations:**

1. A middleware calls `$next->handle($request)`; the action records a successful write and returns success. The middleware then returns `ErrorResponse::make($request, 422, 'Postprocessing failed')`. The final PSX envelope says `execution: 'not-entered'`, code `validation`, even though the recorder proves that the action ran. The fallback equates absence of a throwable cause with non-entry. This also applies to an error returned after output/response postprocessing.
2. An action records a write, then throws `HttpException(422, 'Failure after write')`. PSX emits an ordinary `validation` problem with `execution: 'entered'`. The client treats every readable non-reserved 4xx problem as an expected failure; there is no distinction from an intentionally returned `Failure` asserting rollback/no durable write. The action caller is therefore told an expected rejection after a possible committed write.

**Expected / contract:** Design §16 expressly forbids inferring execution from HTTP status and requires unexpected post-entry exceptions to have unknown mutation outcome regardless of status. A returned `Failure` is an explicit application assertion of no durable write (§7/§16); an arbitrary middleware response or thrown 422 is not that assertion.

**Impact:** The caller can be told nothing ran, or that a write was safely rejected, after it ran. Retrying based on that result can duplicate writes. The converse known gap (a guard exception called entered) does not capture this unsafe direction.

**Narrow fix:** Carry request-scoped invocation entry and expected-outcome provenance through the framework invocation/error boundary. Preserve it across middleware clones/replacements and exceptions. Only explicit pre-entry refusal or an application-returned `Failure` may claim the corresponding safe outcome. Never keep this state on a shared singleton. Make the stable control/client contract distinguish unexpected entered failures even for 4xx.

**Regression expectation:** Record action entry/write count in tests for pre-entry binder/guard rejection, guard throws, returned `Failure`, action throws 422/409/500 after write, serialization failure, and middleware returning or throwing an error after `next`. Assert both the wire provenance and the actual browser runtime result: unexpected post-entry failures reject with `RequestFailure.outcome === 'unknown'`, with no automatic POST retry.

## R1-S02 — High — Strict JSON input loses object/list identity and accepts unsafe integers before entry

**Locations:** `framework/src/Http/StrictDecoder.php:88-109`; `framework/src/Http/Request.php:544-551`; `psx/src/Runtime/OperationHandler.php:38-46`. The normal binder consumes the already collapsed associative arrays.

**Trigger:** A readonly input DTO contains a child DTO with all defaults, `#[ListOf('int')] array $items`, and `int $id`. Send raw JSON equivalent to:

```json
{"child":[],"items":{"0":7},"id":9007199254740993}
```

**Observed:** HTTP 200 action success. The action records child default data, list `[7]`, and integer `9007199254740993`. `Request::decodeJson()` uses associative `json_decode`; JSON object `{"0":7}` becomes a PHP list. This is a **nonempty** object/list collision, beyond the empty-array ambiguity mentioned in STATUS. No input safe-integer check runs before entry; that ID cannot be represented exactly by the generated JavaScript number type.

**Expected / contract:** Design §15 and the strict-decoding acceptance gate preserve JSON object/list distinctions at every depth and reject out-of-JS-safe-range numeric values unless explicitly declared decimal strings. An array is not a DTO object, and an object with numeric keys is not a JSON list. Invalid input must not enter application code.

**Impact:** Schema-invalid payloads can authorize/perform writes with values that the public contract cannot represent faithfully. Strict decoding's guarantees differ from the generated client/output validation.

**Narrow fix:** Retain object/list structure through strict decoding and binding, using a core-supported representation/shape metadata rather than an untyped associative-array collapse. Validate safe numeric ranges in the PSX input path before entry, retaining ordinary non-PSX Crab behavior. Explicit string IDs remain strings.

**Regression expectation:** Test nested empty and nonempty numeric-key objects vs lists at several depths; nested `[]` vs default DTOs; positive/negative safe integer boundaries in JSON, query, and multipart; assert invalid cases never increment the action entry counter. Test valid `{}` DTO and `[]` list separately.

## R1-S03 — Medium — Document requests bypass strict PSX query decoding

**Locations:** `psx/src/Runtime/StrictPolicy.php:25-29`; `psx/src/Runtime/PageHandler.php:43-66`.

**Trigger:** A page loader declares `load(#[FromQuery] string $q = '')`. Request `/review?q=one&q=two` once as an HTML document and once as PSX navigation.

**Observed:** Document: HTTP 200, loader entered with `q === 'two'`. Navigation: HTTP 400 `bad_request/not-entered`, loader never entered. The early decode policy selects only protocol-header requests or paths containing `/_psx/`; the page's normal document URL matches neither. `PageHandler` also calls `readable()` only for navigation.

**Expected / contract:** Design §§6/7/15: document and navigation use the same declared loader schema and strict decoding, with ambiguous duplicates refused before loader entry. Permissive `parse_str` truncation/normalization is expressly not an acceptable PSX path.

**Impact:** Reloads, pasted links and server-rendered documents observe different query values/validation from client navigation, and document input is exposed to permissive parsing/truncation that strict PSX decoding was introduced to prevent.

**Narrow fix:** Select strict decoding by registered page/operation identity early enough to precede middleware/body/query reads, including HTML requests. Do not apply a broad substring heuristic to unrelated ordinary routes. Validate the request before loaders for both representations.

**Regression expectation:** Compare document and navigation for duplicate scalar leaves, dots/spaces, mixed/sparse arrays, depth/node bounds, and layout/page composite query fields. Assert no loader runs on an ambiguous request; ordinary Crab routes without PSX identity keep their existing parser behavior.

## R1-S04 — High — Protocol/build preflight happens only inside PSX handlers, so ordinary dispatch can execute a stale write

**Locations:** `psx/src/PsxPlugin.php:111-118` (definition, representation, and decode-policy registration); `psx/src/Runtime/OperationHandler.php:38-46`; `psx/src/Runtime/PageHandler.php:45-53`; `psx/src/Runtime/PsxRepresentation.php:28-40`; `psx/src/Runtime/Responder.php:170-180`.

**Trigger:** In a PSX-enabled fixture, register ordinary `POST /ordinary` with an entry recorder. Send a POST carrying PSX media/protocol/build/schema headers, protocol `99`, build `old`, schema `old`. A second case uses supported protocol `1` with old build/schema.

**Observed:** The ordinary route runs and returns HTTP 200, with `ordinary entered` recorded. Nothing before dispatch validates the global protocol/build identity. The error representation can rewrite an already-returned 404/405 into a mismatch, but cannot prevent an ordinary route or fallback from entering.

**Expected / contract:** Design §16 explicitly requires a protocol preflight/representation layer at the application request boundary before matched-handler dispatch. Unsupported protocol and stale builds must be non-executing refusals, including when a removed operation address now matches an ordinary/fallback handler. Ordinary requests **without** PSX headers retain their existing behavior.

**Impact:** The old-tab write safety guarantee is conditional on the URL still matching a PSX handler. Route changes or ordinary fallbacks can execute unsupported/stale writes and return an unreadable response after the mutation occurred.

**Narrow fix:** Validate the global protocol/build at the request boundary whenever PSX protocol headers identify the request; validate route-specific schema after routing but before operation entry. Keep authorization/middleware semantics explicit and avoid adding a callable catch-all. Missing operations with matching builds remain stable 404/not-entered.

**Regression expectation:** Test obsolete/unsupported PSX POSTs against current PSX operations, removed paths, ordinary routes and ordinary dynamic fallbacks; assert handler entry count zero. Cover supported/current build missing routes, and prove ordinary non-protocol requests still execute normally.

## Additional observations still being adjudicated

The same harness records document `Accept: application/json` receiving HTML 200; an unguarded wrong-origin action entering; and `authChanged()` succeeding on an unmarked action with no auth adapter. The origin/configuration and auth-marker boundaries are under further review; these observations are not silently promoted to vulnerability claims here. Compiler/Vite/SSR review is continuing separately.

## R1-S05 — Medium — An unmarked action can report an auth transition without the required adapter/revision contract

**Locations:** `psx/src/ActionResult.php:82-91`; `psx/src/Runtime/OperationHandler.php:38-46`, `74-94`, `120-134`; `psx/src/Runtime/PsxDefinition.php:183-193`. The client's pre-send transition classification comes from generated `operation.auth`, not the later response flag.

**Trigger:** Declare plain `#[Action]`, with no `auth: true` and no `psx.auth_state`, returning `ActionResult::ok('in')->authChanged()`.

**Observed:** Compilation, application definition and invocation all succeed. HTTP 200 contains `authChanged: true` with no AuthSnapshot. This is reproduced by the `unmarkedAuth` operation in `server.php`.

**Expected / contract:** `ActionResult::authChanged()` explicitly documents “only an #[Action(auth: true)] may.” Design §17 requires explicit opt-in, an AuthState adapter and revision checks for generated in-app identity changes. The generated marker also enables client write serialization/barriers before a transition POST. `PsxApp.authChanged()` remains a distinct supported notification for changes outside generated operations.

**Impact:** An easy application misdeclaration silently opts out of startup validation, expected-revision sending/checking and pre-send transition serialization, while its result claims to be a supported auth transition. Merely handling snapshots after the response (C04) cannot restore those omitted pre-send guarantees.

**Narrow fix / regression:** Enforce that a generated response with `authChanged` comes from a declared auth transition with an adapter; reject/diagnose the misdeclaration and avoid sending transition cookies as a normal success. Since the method has already entered, a runtime contract error must remain an unknown mutation outcome (S01), not falsely claim non-entry. Test unmarked+no-adapter, unmarked+adapter, marked-without-adapter startup refusal, and marked valid/stale revision. Document the application's separate atomic revision/credential responsibility; a PSX snapshot comparison alone cannot supply that transaction.

## R1-S06 — Medium — Definition eagerly constructs worker services in the parent process

**Locations:** `psx/src/Runtime/PsxDefinition.php:70-94`; `framework/src/AppBuilder.php:290-324`; `framework/ARCHITECTURE.md:142-161`, `276`.

**Trigger:** Configure an AuthState class whose constructor records when it is constructed. Compile a fixture, then call `FixtureApp::serve()` (which creates/defines the App but performs no request or runtime start).

**Observed:** Constructors after compilation: 0. Constructors after application definition, before runtime/requests: 1. Recorded chain: `__construct <- build <- get <- finish <- finish <- define <- create <- serve`. `finish()` resolves the configured AuthState, and also any custom DocumentRenderer/RendererTransport, through `container->get()`. These objects are retained in handlers made before worker fork.

**Evidence:** `/tmp/psx-r1-repros-GH7CnoFu/lifecycle.php`, `lifecycle.log`, visible terminal `psx-r1-lifecycle`.

**Expected / contract:** Framework definitions are process declarations and “make no service”; application services are constructed per worker. Wiring is checked without constructing services. This finding concerns **actual premature construction**, not the deliberately reflection-only startup validation that the review handoff says to preserve.

**Impact:** Custom adapters/render transports and their dependencies run in the parent and are copied into workers; worker-specific initialization can run at the wrong time. No real cross-request credential leak or inherited socket was demonstrated; the reproduced violation is the lifecycle boundary itself.

**Narrow fix / regression:** Keep service identities/factories in definitions and resolve worker instances in worker setup or appropriate worker-local handlers. Use existing nonconstructing dependency inspection to validate wiring. Assert constructors remain untouched through collection/definition/check, and that each worker first constructs its own service after fork.

## R1-S07 — Medium — Page documents ignore HTML Accept negotiation

**Locations:** `psx/src/Runtime/PageHandler.php:43-55`, `131-146`, `253-258`; `psx/src/Runtime/Protocol.php:31-44`.

**Trigger:** Request a page with `Accept: application/json` and no PSX protocol selector.

**Observed:** HTTP 200 `text/html`, and the loader runs. `server.php` records this. All requests not recognized as protocol are treated as document requests, without checking whether HTML is acceptable.

**Expected / contract:** Design §16 requires normal HTML document negotiation and 406 for unsupported acceptable representations, respecting quality values including q=0.

**Impact:** API clients and explicit HTML refusals receive an unwanted successful representation; loader work runs for requests that should be refused before entry.

**Narrow fix / regression:** Check HTML acceptability before invoking document loaders, using correct specificity/q semantics. Test JSON-only, `text/html;q=0`, explicit HTML q=0 plus positive wildcard, HTML-capable browser headers, absent Accept, and the protocol media type. Preserve ordinary non-PSX routes' behavior.

## Disposition of the wrong-origin observation

The scratch fixture deliberately installs no CookieAuth or SameOrigin middleware and has no credential-bearing state. `PsxPlugin` documents that auth/session middleware belongs to the application. `Crab\Http\SameOrigin` is available as a standalone guard and `CookieAuth` calls it; the real demo applies `CookieAuth(required:false)` to ordinary login/logout and `CookieAuth` to all its stateful generated actions. A browser also cannot send the required PSX custom headers cross-origin without a successful CORS preflight. **This repro is not a demonstrated CSRF vulnerability or a reason to add authentication implicitly.**

The package README/scaffold do not explain the required SameOrigin configuration for public/session-only mutations. Add that guidance and acceptance tests for the supported explicit-guard configuration, including wrong/missing Origin, configured app.url behind proxies and normal same-origin requests. This is a documentation/acceptance coverage gap, distinct from confirmed S01–S07.

## Added verification

`psx-r1-server-final` ran `php server.php` followed by `node provenance.mjs`. The latter feeds the **raw actual PHP response bodies** through the pre-fix actual client `exchange()`; it confirms both the thrown-422 and post-next-422 paths resolve as expected problems (entered and not-entered respectively). An earlier attempt re-encoded the test helper's associative envelope, changing empty objects to arrays; that invalid harness correctly caused a protocol failure and was corrected by saving raw bodies. Final evidence is `provenance.log`.


## R1-B01 — High — Vite asset URL transformation publishes PHP source, bypassing the release leak gate

**Locations:** `psx/js/src/vite.ts:144-223` (import/load checks and entry-only transform); `psx/src/Commands/PsxBuild.php:100-105`, `157-203` (plaintext leak scan), `117-140` (publication/selection).

**Trigger:** In an otherwise valid minimal PSX application, put this ordinary Vite expression in `resources/entry.tsx`:

```ts
console.log(new URL('./pages/Home.psx', import.meta.url).href);
```

`Home.psx` is a declared page containing a private PHP DTO and Server class followed by a normal default component. Use a small file, within Vite's normal asset-inline limit. Run the standard `php cua psx:build` command, including typecheck.

**Observed:** The build succeeds, publishes assets and selects release `7bf5da9f2c3a27d8` in the isolated fixture. `public/assets/psx/assets/entry-DkE3pHZu.js` contains a base64 data URL decoding to the **entire original .psx**, including `<?php`, its private PHP class/method bodies and the review sentinel. Neither the plugin's `resolveId`/`load` rejection nor its dev middleware sees Vite's direct asset URL file read. The actual `PsxBuild::leaks()` returns `[]` because it scans plaintext PHP substrings, not encoded asset contents.

**Evidence:** `/tmp/psx-r1-repros-GH7CnoFu/vite-repro.mjs` and `vite.log` demonstrate the actual plugin; `server.php` invokes the actual leak scanner on the resulting asset. `/tmp/psx-r1-repros-GH7CnoFu/full-build/` contains the complete minimal app, and `full-build.log` records the successful standard build. Visible terminals: `psx-r1-vite`, `psx-r1-full-build2`. The earlier full-build attempt was refused because the scratch loader returned a scalar rather than a props DTO; it was corrected before the successful reproduction. Only a synthetic sentinel was used, never real secrets.

**Expected / contract:** Design source privacy/compiler/Vite and release acceptance gates: browser output must never contain PHP regions, private server source or manifests; raw/file/asset import variants must be rejected. The final release scan is intended to prevent publication if a transform bypass occurs.

**Impact:** A normal Vite URL expression accidentally referencing a server-bearing file can expose private implementation and any literals in it to every browser. The approved build command asserts success and publishes it. This is a demonstrated output leak, not a claim that an unauthenticated attacker can modify the entry source.

**Narrow fix:** Enforce the private-file boundary for Vite asset references as well as module imports, canonicalizing URLs/aliases/queries and guarding direct asset transformations. Include PHP/.psx/private build paths. Make the release check inspect emitted/inlined asset content structurally, including data URLs, and fail closed before publishing/selecting. Preserve legitimate .psx component and `?server` imports.

**Regression expectation:** Run real Vite builds and the full build command with `new URL()` references to private .psx/.php files, inline and emitted assets, raw/url imports, aliases, source maps and private manifests. Assert failure with old selection/assets intact and zero public sentinel bytes after decoding all generated asset representations; separately verify legitimate image URLs and split components still build.

## R1-B02 — Medium — Development selects invalid generations before fresh route/dependency validation

**Locations:** `psx/src/Commands/PsxCompile.php:31-59`; `psx/src/Runtime/DevelopmentSteps.php:28-39`; `framework/src/Server.php:401-424`.

**Trigger:** Compile a valid page `/`. Then add an ordinary `GET /` route and change the page's PHP. Run the development preparation command `php cua psx:compile` again.

**Observed:** Compile exits 0 and switches `build/psx/dev/current` from `24b20078717bdb82` to `2a91febf3e47f51a`. Running `php cua psx:verify --release=<selected-new-release>` in a fresh process immediately exits 1: `Route GET / is already defined`. The development hook only runs compile, so the framework watcher sees successful preparation, stops the previous server and starts the invalid one. This is not the deliberate framework convention of inspecting service wiring without constructing services: the missing step is the existing fresh-process definition/validation used by production builds.

**Evidence:** `/tmp/psx-r1-repros-GH7CnoFu/dev-repro.py`, `dev.log`, disposable `dev-case/`; visible terminal `psx-r1-dev`. The repro directly proves invalid selection and fresh definition failure. The subsequent watcher stop/start consequence is verified from its source, without stopping any live demo.

**Expected / contract:** Design development/release handling and README command promise: invalid changes leave the last good server/generation available. Route collisions and dependency errors are invalid changes, not only PHP syntax errors.

**Narrow fix:** Freshly define/verify the staged generation, including normal framework unmade dependency checks, before moving the development pointer or notifying the watcher to restart. Publish generated browser artifacts coherently with that accepted generation. Do not replace normal framework worker lifecycle with eager service construction.

**Regression expectation:** Start a disposable dev app, introduce route collision and missing nested dependency separately, and prove old requests/browser artifacts still work while the error is reported. Fix the error and verify exactly one successful generation switch.

## R1-B03 — Medium — SSR timeouts free concurrency slots while the timed-out render still runs

**Locations:** `psx/js/src/socket.ts:48-72`, `129-137`.

**Trigger:** Use the real socket listener with `maxInflight: 1`, `maxQueue: 1`, a 30 ms timeout and a render function that takes 300 ms. Send four complete requests sequentially, each after the previous timeout response.

**Observed:** All four return bounded failure responses, but **four render functions are simultaneously still active**. `Promise.race` rejects on timeout without cancelling the underlying render; `work(...).finally()` immediately decrements `inflight` and admits another job. The maximum counts response waits rather than actual work/resources. Repeated timeouts can retain arbitrarily many pending render jobs until the process memory cap/restart intervenes.

**Evidence:** `/tmp/psx-r1-repros-GH7CnoFu/ssr-repro.mjs`, `ssr.log`; visible terminal `psx-r1-ssr`. Output: `maxInflight=1, timed-out jobs still active=4, peak actual render work=4`. Own temporary Unix socket; no demo renderer touched.

**Expected / contract:** Design SSR requires bounded in-flight work, queues, timeout and cancellation handling. Returning a timeout must not turn off the work bound.

**Narrow fix:** Retain the slot until underlying work really settles, or run cancellable/isolated jobs and terminate them before releasing capacity. Account for disconnected and timed-out queued jobs as well. Avoid treating the timeout response itself as proof of cancellation.

**Regression expectation:** Assert peak active work, retained jobs and queue length under repeated timeouts/disconnects, not only response latency. Verify useful requests recover after timed-out work settles and no stale result is sent/installed.

## R1-B04 — Medium — Catch-all page families shadow their generated query endpoints

**Locations:** `psx/src/Registry/Registry.php:159-178`; `psx/src/Compiler/Families.php:340-345`; `psx/src/Runtime/PsxDefinition.php:95-119`; `framework/src/Routing/Router.php:128-132`, `560-570`.

**Trigger:** Declare page `/files/{tail:.+}` with a loader and `#[Query] ping(string $tail): string`. Invoke the generated query with `tail=a`.

**Observed:** Compilation and application definition succeed. The generated GET query URL is matched by the earlier page catch-all, and returns HTTP 409 `build_mismatch/not-entered` even though the request's build is current. It never returns the expected `pong:a`. Only exact string-pattern duplicates are checked by Router; reserving a literal `_psx` segment in declarations does not prevent a parameter regex from swallowing it.

**Evidence:** `/tmp/psx-r1-repros-GH7CnoFu/compiler.php`, `compiler.log`, visible terminals `psx-r1-compiler` and `psx-r1-compiler2`.

**Expected / contract:** Design §8 expressly requires catch-all/endpoint collision checks and rejects a family that cannot expand unambiguously, directing the application to a separate service mount.

**Narrow fix / regression:** Validate expanded endpoint reachability/collisions before accepting the family, preserving actual parameter constraints. Reject this case with both declarations and a separate-service remedy; test greedy/multi-segment patterns, overlapping ordinary routes and valid single-segment constrained families. Do not change ordinary Crab precedence globally to disguise invalid PSX expansion.

## R1-B05 — Medium — Distinct module paths collapse to the same PHP namespace

**Locations:** `psx/src/Compiler/Source.php:54-67`; `psx/src/Compiler/Compiler.php:49-56`, `77-94`, `143-158`.

**Trigger:** Declare both `resources/pages/foo-bar.psx` and `resources/pages/foo_bar.psx`, each with a local `Data` and `Server` class, at distinct routes. Similarly, PHP names are case-insensitive even on case-sensitive filesystems.

**Observed:** Source parsing maps both punctuation variants to the same `...\pages\foo_bar` namespace. Compilation exits 255 with an uncatchable `Cannot redeclare class ...\pages\foo_bar\Data` fatal, after loading the first file. `Foo.psx` and `foo.psx` produce namespace spellings differing only by PHP-irrelevant case. There is no collision check before generated PHP is loaded.

**Evidence:** `compiler.php`/`compiler.log`; the final fatal is the intentional outcome of `psx-r1-compiler2`, not an unexplained test-harness failure. The two page URLs and client module IDs are otherwise distinct.

**Expected / contract:** Design local module namespaces prevent one file's Server/types from colliding with another; compiler symbol collisions must be diagnosed before executing/generated loading.

**Narrow fix / regression:** Use an injective, stable mapping from canonical module path to PHP symbol identity (including PHP case folding), or detect and reject all collisions before loading any generated PHP with both source paths named. Test punctuation/underscore, leading-digit/underscore and case variants. Preserve deterministic builds and provide a source diagnostic rather than a PHP fatal.

## Commands and results

The coordinator ran the existing PSX PHP suite, npm suite, TypeScript check and demo PHP suite before fixes, all exit 0 (`/tmp/psx-review-baseline-6gjmw6zu/tests.log`). Demo baseline is **6 tests / 88 assertions**. I did not claim those as my independent executions or rerun stateful demo/browser suites. The coordinator independently reproduced the early client, server and source-leak findings.

My isolated executions used visible hc terminals and actual source, in `/tmp/psx-r1-repros-GH7CnoFu`:

| Command / artifact | Result |
| --- | --- |
| TypeScript build to scratch `dist/`; `node client.mjs` | Pre-fix actual runtime; all eight observations in C01–C07 reproduced; `client.log` |
| `php server.php` | Real temporary fixture/compiler/framework; S01–S05/S07 behaviors and leak-scanner result; `server.log` |
| `node provenance.mjs` | Raw PHP thrown/postprocessing 422 bodies resolve as expected client problems; `provenance.log` |
| `node vite-repro.mjs` | Actual Vite plugin emits base64 PHP source; `vite.log` |
| `php cua psx:build` in `full-build/` | Default typecheck + real Vite + publication + release selection exit 0, despite decoded public PHP sentinel; `full-build.log` |
| `python3 dev-repro.py` | Valid compile and invalid compile both exit 0; pointer changes; fresh verify exits 1; `dev.log` |
| `node ssr-repro.mjs` | Four unresolved render jobs under maxInflight=1; `ssr.log` |
| `php lifecycle.php` | AuthState constructor runs at definition before runtime/request; `lifecycle.log` |
| `php compiler.php` | Catch-all query misrouted; distinct module namespace collision ends with intentional redeclaration fatal; `compiler.log` |

Harness corrections are disclosed in the batch evidence: an initial JS literal syntax error; wrong scratch FromQuery import; a scalar scratch loader rejected before the full-build repro; and associative test-helper JSON re-encoding corrected to raw response bodies. The findings rely on the corrected successful observations. Node in the visible test terminals was v22.22.2, Vite v8.3.8; the documented Node 24 target was not independently tested here. No dependencies were installed or production build artifacts regenerated.

## Inspected areas and interpretation

The complete DESIGN, STATUS and IMPLEMENTATION-REPORT were considered alongside the handoff, applicable AGENTS instructions and framework architecture/component conventions. Source review covered the compiler/source split, module reflection, shapes and generated bindings, declaration/family expansion, PHP invocation/serialization/representations, input policy, client transport/scopes/router/auth/cache/React integration, Vite/build/dev/SSR paths, framework integration diffs and relevant request/router/error/auth lifecycle paths. Existing tests were sampled to distinguish happy-path proofs from the adversarial cases above.

The demo review included declared guards/routes, ordinary login/logout, post service/versioned updates, upload/storage handling, public DTOs and page/component flows. Its authenticated family protections and explicit ordinary login/logout guards are correctly applied. Its same-post version predicate performs atomic compare-and-update rather than an unsafe read-then-write check. The demo's ordinary document login does not prove in-app AuthState transitions. I did not change or exercise its live data.

Framework startup's intentional **nonconstructing** wiring inspection is not a defect. S06 instead proves services are actually constructed during definition. Generic application authorization remains the application's responsibility; lack of automatic identity creation is not a PSX defect. The wrong-origin synthetic fixture is adjudicated above as missing explicit guard configuration/documentation, not a proven browser CSRF exploit. Existing lack of an editor extension or performance measurements is not turned into individual implementation defects.

## Coverage limits and non-defect backlog

This is a focused initial acceptance review, not exhaustive proof of every design gate. In particular:

- No independent real-browser cross-tab auth/cookie ordering, hydration/StrictMode matrix, service-worker/proxy behavior, production rolling reload/rollback, or non-Linux platform run was performed. The first client repro uses actual runtime code with JSDOM and controlled network promises.
- The live demo was not restarted, reconfigured or mutated. Upload cancellation/temp-file cleanup, actual multi-user resource policy and hostile multipart/proxy limits still need isolated end-to-end acceptance tests.
- No release was published to a registry; npm/Composer packed artifact contents, a clean downstream installation and compatibility against the declared framework release remain packaging acceptance work.
- SSR private directory ownership/mode/ancestor-symlink handling, startup readiness enforcement and renderer overlap/restart behavior need a dedicated deployment check. The confirmed SSR work-bound issue is B03; those other boundaries are not certified by that one repro.
- Client response streaming/byte limits and full stable-control-envelope/header validation, cache eviction/prefetch invalidation under pressure, composite loader validation before the first loader, and hostile scalar/form coercion beyond S02 remain explicit follow-up audit leads. They are not represented as completed adversarial coverage.
- Add public/session-only origin-guard guidance and tests. Add semantic/browser tests for no-JS ordinary login, stale writes/uncertain outcomes, draft preservation and resource cleanup. Performance budgets and editor tooling can be tracked separately from the security/correctness fixes.

Any re-review should use the corrected actual implementation with fresh counterexamples, verify that the specific defects are closed, and check for regressions introduced by the fixes. This initial report remains the baseline record even after individual IDs are fixed.
