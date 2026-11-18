# PSX implementation review — round 1, early server findings

Independent review of actual package/framework source against `docs/DESIGN.md`. These stable IDs are retained in the final report. This is a fix handoff, not acceptance of the remaining implementation. No production edits were made. Source references are relative to `/home/daudau/Code/crabphp`; attribution is to the pre-fix snapshot `/tmp/psx-review-baseline-6gjmw6zu` and unchanged PHP/framework source inspected on 2026-11-15.

Repro: `/tmp/psx-r1-repros-GH7CnoFu/server.php`, output `server.log`. It uses the package's real `FixtureApp::copy()`, actual compiler, router, binder, middleware and handlers; all application changes are in disposable temporary fixtures. No demo server or database is touched. `php server.php` ran in visible hc terminals (`psx-r1-server2`, then `psx-r1-server-final`). The initial failed run used the wrong namespace for `FromQuery`; that scratch error was corrected to `Crab\Routing\FromQuery` before the observations below. The package/demo baseline suites were reported green by the parent; they do not cover these cases.

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
