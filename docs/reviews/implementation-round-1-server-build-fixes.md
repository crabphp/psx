# Server and build fixes, rounds 1 to 3

2026-11-15. This answers [implementation-round-1.md](implementation-round-1.md) (R1-S01 to S07, R1-B01 to B05), the client items [implementation-round-2-client.md](implementation-round-2-client.md) left open (R2-C02 to C05 and the rest of R1-C04), and the findings the coordinator sent while this work ran (R3-B01, R3-S01, R3-C01, R3-C02). The handover was `/home/daudau/Code/brainstorm/psx/SERVER-BUILD-FIX-HANDOFF.md`.

Nothing was committed, pushed or published. The user's preview on port 8094 was not touched; the browser run used a copy at `/tmp/psx-demo-clean` on port 8095.

**State of review.** The independent reviewer (Codex) re-reviewed part of this and then stopped. The last column below records only what the coordinator told me the reviewer or the coordinator had checked independently, on the code as it was at that time. Rerunning the coordinator's defect probes myself, as recorded under "Commands and results", is **not** independent re-review, and a probe that stops at its first changed assertion says nothing of the cases after it. **The package is not accepted and not ready for production.**

## Findings

| Id | State | Independent re-review |
| --- | --- | --- |
| R1-S01 provenance of a failure | Fixed | Passed (coordinator's matrix and raw PHP repro) |
| R1-S02 strict input | Fixed, reopened as R3-S01, fixed | Original passed; enum part not re-reviewed |
| R1-S03 document query decoding | Fixed | Passed (matrix) |
| R1-S04 preflight before dispatch | Fixed | Passed (matrix) |
| R1-S05 unmarked `authChanged()` | Fixed | Passed |
| R1-S06 services made in the parent | Fixed | A positive two-worker checkpoint by Codex before it stopped; no final re-review |
| R1-S07 HTML negotiation; SameOrigin guidance | Fixed; guard documented and tested | 406 passed; the SameOrigin test not re-reviewed |
| R1-B01 PHP published through Vite | Fixed, reopened as R3-B01, fixed; the `vendor/` exemption then removed | Original `.psx` cases passed; nothing after R3-B01 re-reviewed |
| R1-B02 development selects unverified output | Fixed | Not reported |
| R1-B03 renderer slots freed on timeout | Fixed | Not reported |
| R1-B04 catch-all shadows queries | Fixed; reopened for sampling and ordinary routes, redone by proof | Not re-reviewed |
| R1-B05 namespace collisions | Fixed | Not reported |
| R2-C02 stale `auth_transition` refusal | Fixed, then generalised by R3-C02 | Passed before R3-C02 changed it |
| R2-C03 auth lock ownership | Fixed | Passed |
| R1-C04 partial errors | Fixed, including top-level snapshot | Fail-closed part passed; top-level part not re-reviewed |
| R2-C04 `replace` on a document navigation | Fixed | Not reported |
| R2-C05 overtaken history traversal | Fixed | Not reported |
| R3-B01 private JSON and other modules | Fixed | Not re-reviewed (I reran the coordinator's probe; see below) |
| R3-S01 unsafe integer enums | Fixed | Not re-reviewed |
| R3-C01 unexpected query failure as `QueryProblem` | Fixed | Not re-reviewed |
| R3-C02 guard refusal of an auth action | Fixed | Not re-reviewed |

## Server

### R1-S01: what is said of a failure is what the server knows

**Invariant.** `execution` is whether the method was called, as the router recorded it. `expected` is true only for a refusal before the method and for a `Failure` the method returned. The client treats any other problem as an unknown outcome and sends nothing again.

**Changed.** Framework: `src/Contracts/Routing/Entered.php` (new), `src/Http/RenderedErrors.php` (puts the record on the request as `crab.entered` when a package has registered a representation), `src/Routing/ActionHandler.php` (marks it immediately before the call). PSX: `src/Runtime/Responder.php` (`execution` from the record, `expected` in every problem envelope), `src/Testing/PsxResponse.php` (`expected()`). Client: `js/src/protocol.ts`, `js/src/runtime.ts`, `js/src/testing.ts`.

**Evidence.** `tests/ContractTest.php`: thrown after the write, a middleware that answers or throws after the method, a middleware that throws before it, input and path that do not bind, another release. `js/test/races.test.ts` "R1-S01". Framework `tests/Integration/PackageContractsTest.php` (entry record).

### R1-S02 and R3-S01: strict input

**Invariant.** On a PSX route, and only there, a body keeps the difference between an object and a list down to the binder; a typed list must be a list and a class an object; every integer (int, float given as int, union, integer-backed enum; in JSON, a form, the query and the path) is within ±9007199254740991. An integer-backed enum with a case outside that range does not compile; such a value is not sent; the browser takes no unsafe number for an enum's value. An ordinary route binds as before.

**Changed.** Framework: `src/Http/StrictDecoder.php` (`json()` returns an `\stdClass` tree, `plain()`), `src/Http/Request.php` (`exactBody()`), `src/Validation/Validator.php` and its contract (`$strict`; object/list identity; bounds, also for enums), `src/Routing/ActionHandler.php` (strict when the request has a decode policy; path integers bounded). PSX: `src/Compiler/Shapes.php` and `src/Compiler/Families.php` (`exact()`: enum cases, with file and line), `src/Runtime/WireCodec.php` (enum output), `js/src/shapes.ts` (enum guard).

**Evidence.** Framework `PackageContractsTest` (strict shapes, forms, nested, nullable and list enums, query, form and path, the safe boundary both ways, the loose route unchanged) and `tests/Http/StrictDecoderTest.php`. PSX `tests/CompilerTest.php` (unsafe enum declarations refused with their source), `tests/ContractTest.php` (`testAnEnumValueJavaScriptCannotHoldIsNotSent`, strict bodies, forms, query, path), `js/test/shapes.test.ts`. The coordinator's `/tmp/psx-security-check-3vi030sy/server-matrix.php` now stops at compilation: `enumInput() takes an enum with the value 9007199254740993` (exit 255; it compiled and returned 200 before).

### R1-S03: documents decode the query strictly

`src/Runtime/PageHandler.php`, `Responder::readable(document: true)`: a document request is read as a navigation is; what it refuses is answered by the application's own error page. `ContractTest`: duplicate and unsafe query values give the same 422 for a document and a navigation.

### R1-S04: protocol and build are checked before routing

**Invariant.** A request that speaks the protocol with another build or protocol is refused before any route, guard or fallback runs.

**Changed.** `src/Runtime/Preflight.php` (new, global middleware added by `PsxPlugin`), `src/Runtime/StrictPolicy.php`, `src/Runtime/PsxRepresentation.php`, `src/Runtime/Kernel.php` (`$names`); framework `Router::match()` (contract and implementation) so a package can ask which route an address is without dispatching.

**Decision to confirm.** Preflight runs before route guards. A malformed protocol request now gets 409 where a guard would have said 401 or 403. Two assertions of `psx-demo/tests/browser/demo.test.mjs` were changed for this, and only for this: the visitor test asks with `Accept: application/json` for its 401 and asserts a protocol request without a build is 409 `not-entered`; the cross-site post sends `Accept: application/json`.

**Evidence.** `ContractTest`: an old release's action, a removed address, an ordinary fallback route (`/old/{rest:.+}`) that must not run, ordinary routes untouched.

### R1-S05: `authChanged()` from an unmarked action

`src/Runtime/OperationHandler.php` throws a `PsxException` naming the method: a 500, `entered`, `expected: false`, no cookie sent. `ContractTest` covers it with and without an `AuthState`.

### R1-S06: nothing of the application is made in the parent

`src/Runtime/Services.php` (new) makes the `AuthState`, the renderer and the transport on first use in a worker. `src/Commands/PsxVerify.php` reports `App::current()->unmade()`, so a missing dependency is still found before serving. `ContractTest` (`testNothingOfTheApplicationsIsMadeUntilAWorkerNeedsIt`, `testAnAuthStateThatCannotBeMadeIsSaidWithoutMakingIt`), fixtures `tests/Support/CountingAuth.php`, `NeedsMissing.php`.

### R1-S07: HTML negotiation, and the guard of a public action

A document request that does not accept HTML is answered 406 (`Responder::html()`); `ContractTest` covers `q=0`, wildcards and the ordinary route.

The review did not show a cross-site exploit and none is claimed. What was missing was guidance: an action of a page with no login has no origin check unless the application names one. `README.md` ("An action anyone may call") says so and shows `->operation('send', SameOrigin::class)`. `ContractTest::testAnActionWithoutALoginIsGuardedBySameOriginWhereTheApplicationSaysSo` (42 assertions) proves through the real router: the application's origin and `Sec-Fetch-Site: same-origin` pass; another site, port or scheme, no `Origin`, and `Origin: null` are 403, `not-entered`, with the action not run; a configured public address holds behind a proxy.

## Build

### R1-B01 and R3-B01: nothing of the server's reaches a script

**Invariant.** The boundary is a set of paths, not a scan for PHP. PHP files (`.psx` among them), `.env*`, and `build/`, `storage/`, `vendor/`, `config/`, `database/`, `app/`, `routes/` are private for every kind of import: module, JSON, `?raw`, `?url`, asset, glob, through a link. The publish step does not trust the plugin: it re-reads the list of every file the bundle was made of.

**Changed.** `js/src/private.ts` (`secret()`), `js/src/vite.ts` (`load` refuses any private file; `generateBundle` checks every module and asset and writes `.vite/psx-inputs.json`), `src/Commands/PsxBuild.php` (`inputs()` judges that list again for the browser and renderer builds, then deletes it; a release is published only after), `src/Compiler/Compiler.php` (`publish()`).

**Evidence.** `js/test/vite.test.ts`: real builds importing `config/private.json`, `build/psx/private-manifest.json`, assets and raw files, with a plugin placed before ours, and the inputs list. `tests/ToolingTest.php::testAReleaseIsNotPublishedWhenItsScriptsWereMadeOfTheServersFiles`. The whole command, on the copy: `php cua psx:build` with `import secret from '../config/private.json'` added to the entry exits 1 with `config/private.json is in config/, which is the server's, and no script is given it.`; `build/psx/current` was unchanged and the sentinel was nowhere under `public/build`. The coordinator's `/tmp/psx-security-check-3vi030sy/vite-json-check.mjs` now fails with the same message (exit 1; it built and leaked before).

**The `vendor/` exemption is gone.** The first version let a script import from any folder of `vendor/` that held a `package.json`. The coordinator rejected that: a `package.json` is no authorisation. `packaged()` was removed from `js/src/private.ts` and `src/Commands/PsxBuild.php`; everything under `vendor/` is refused, by its own path and through a link from `node_modules/`. A package installed by npm into `node_modules/` builds as before. `js/test/vite.test.ts`: a real build that imports a `vendor/` script beside a `package.json`, and the same script through a `node_modules` link, are both refused; a package of `node_modules/` is bundled and listed. `ToolingTest::testAReleaseIsNotPublishedWhenItsScriptsWereMadeOfTheServersFiles` refuses both in the publish check (14 refusals).

**Consequence, and a proposal not implemented.** A front end that a Composer package ships cannot be imported from `vendor/` at all, also not by `npm install ./vendor/...`, which links. If that is wanted, it needs an explicit allowlist bounded to named public files of named packages (for example `psx.public_packages` in `config/psx.php` mapping a package to its exported files), judged by the plugin and again at publish. I have not built it; it changes the contract and is the coordinator's to decide.

### R1-B02: development selects only what a fresh process can serve

`src/Commands/PsxCompile.php` compiles to a stage, runs `psx:verify --release=` in a new process, and selects only then. `ToolingTest::testDevelopmentSelectsOnlyWhatAFreshProcessCanServe`.

### R1-B03: a timed-out render keeps its slot

`js/src/socket.ts`: a slot is held until the render settles; the queue is bounded; the deadline counts from arrival; a queued job that expired or whose caller left never runs. `js/test/ssr.test.ts` "R1-B03". **Limit:** a render that never settles holds its slot; nothing cancels it.

### R1-B04: a page's own catch-all cannot swallow its queries

**Invariant.** Crab's router answers a path with a static route if there is one, and otherwise with the first route declared, of those with a parameter, that fits. So a query or an action is reached only if no route declared before it, of the same method, can fit its address. That is now refused unless the two patterns are proven apart; the router's precedence is not changed.

**How it is decided.** `src/Compiler/Addresses.php` (new), `shadows($earlier, $later)`, compares the two patterns a segment at a time and never tries addresses. A parameter without an expression is one segment. A parameter with an expression is one segment only if the expression is spelled from letters, digits, `_`, `-`, `.`, `\d`, `\w`, plain classes and ranges of those, groups, alternatives and counts; any other spelling is treated as able to take a `/`. Two routes are apart when their segment counts differ and neither can take a `/`; when a text segment of one cannot be the other's segment at the same place (tested exactly, since the generated segments `_psx`, `q`, `a` and the id are text); or when the text after the last `/`-taking parameter differs, counted from the end. Whatever is not proven apart is refused.

**Where.** `Families::reachable()` at compilation, for a page against its own queries, with the file and the remedy (the sample addresses are gone). `PsxDefinition::add()` when the application is defined, for every query and action with a parameter against every route already declared, ordinary routes included, naming both routes, the `.psx` file and the remedy. This runs in `psx:check`, `psx:verify`, `dev` and `start`.

**Evidence.** `CompilerTest`: seven catch-all spellings refused, four of which the sample addresses let through (`{tail:x/.+}`, `{tail:\S+}`, `{tail:[.-a]+}`, `{tail:[^0-9]+}`); `testWhetherARouteMayAnswerAnothersAddressIsProvenNotTried`, 18 pattern pairs both ways; `testAnOrdinaryRouteDeclaredBeforeThePagesMayNotAnswerAQueryOrAnAction`: an ordinary `GET /{any:.*}`, `POST /posts/{rest:.+}` and `POST /{a}/{b}/{c}/{d}/{e}` are each refused, and `/api/{rest:.+}`, a constrained POST and `/{slug:[a-z-]+}` are let through with both routes answering; `testAParameterOfOneSegmentKeepsItsQueriesHoweverItIsConstrained` still passes (`/tree/{tail:.+}/view` is proven apart by its ending).

**Limits.** It is conservative: a narrow expression spelled another way (`(?i)[a-z]+`, `[^/]+`) is refused although it could not collide. Page documents are not checked against earlier routes: `/posts/new` before `/posts/{id}` is ordinary precedence an application means. A route declared after the pages cannot take a query's address and is not examined.

### R1-B05: two files, one namespace

`src/Compiler/Compiler.php` refuses modules whose paths fold to the same PHP namespace, naming both. `CompilerTest`.

## Client

| Id | Invariant restored | Files | Proof in `js/test/races.test.ts` |
| --- | --- | --- | --- |
| R2-C02, R3-C02 | A refusal of an `auth: true` action is trusted only with the server's word that who is signed in is who the page knows. Otherwise the page is closed in the same turn and settled; the refusal is still returned; the POST is sent once | `js/src/runtime.ts`; server `OperationHandler.php`, `Responder.php` (`unbound()`, `witnessed`) | "R3-C02", 13 tests; `ContractTest::testARefusalOfASignInSaysWhoIsSignedInOnlyOncePastItsGuards` |
| R2-C03 | An auth action releases only its own lock | `js/src/runtime.ts` | "R1-C03" |
| R1-C04 | A partial error's data is shown only as whose it is; the envelope's own snapshot counts when it is this release's and does not contradict the data's | `js/src/protocol.ts`, `js/src/router.ts` (`whose()`); `PageHandler.php` | "R1-C04", 9 tests |
| R3-C01 | A failure the server did not write on purpose is a `RequestFailure` for a query and a navigation as for an action; a declared refusal stays a `QueryProblem` | `js/src/protocol.ts` (decided once, in `exchange`) | "R3", 6 tests |
| R2-C04 | Leaving for a document keeps `replace` | `js/src/router.ts`, `js/src/runtime.ts` | "R2-C04" |
| R2-C05 | An overtaken Back or Forward leaves index, key, address and page together | `js/src/router.ts` (`physical()`, `realign()`, `expectPop`) | "R2-C05" |

**R3-C02 in detail.** The server adds the auth snapshot to a refusal of an `auth: true` action only past its guards and its revision check: a `Failure` the method returned (read after the method, so a revision it moved is seen) and a 422 for input that did not bind. A guard's refusal, a 401, a stale revision and every refusal of an ordinary action carry none, and no loader or `AuthState` runs to write one. The client reconciles unless that snapshot is present, valid, of this release and equal to what it knows.

**A test changed for this contract.** `races.test.ts` "lets go of its own hold when a sign-in is refused": the wrong-password refusal now carries the current snapshot, as the server sends it. Without it the page reconciles, which the new tests assert.

**The coordinator's probes**, rerun by me, unmodified, against the built `js/dist`: `client-history.mjs` exits 1 at its assertion of the old index (`2 !== 3`); `client-auth-lock.mjs` exits 1 at its assertion that a write was possible during another sign-in; `client-advanced-revision.mjs` exits 0. The first two assert the defect, so they stop at the first assertion the fix changed and verify nothing after it. This is my rerun, not the coordinator's re-review. The reviewer's `/tmp/psx-r3-security-awf9eqi0/*.mjs` run against their own snapshot and were not rerun.

## Commands and results

| Where | Command | Result |
| --- | --- | --- |
| `framework/` | `vendor/bin/phpunit` | My run: 2412 tests, 40393 assertions, 44 skipped, exit 0 (3m00s), after the last framework change. The coordinator's own later run: 2412 tests, 40391 assertions, 44 skipped, exit 0 (2m59.950s), `/tmp/psx-security-check-3vi030sy/framework-final.log`. Two executions; I have not explained the difference of two assertions. No framework file changed after either |
| `framework/` | `composer format:check` | clean |
| `framework/` | `composer lint` | 3 hints, all in `src/Engine/Process/`, which this work did not touch |
| `psx/` | `composer test` | 164 tests, 1087 assertions, exit 0 |
| `psx/` | `composer format:check`, `composer lint` | clean |
| `psx/js/` | `npm test` | 5 files, 222 tests, exit 0 |
| `psx/js/` | `npm run typecheck`, `npm run format:check`, `npm run build` | exit 0 each |
| `psx-demo/` | `composer test` | 6 tests, 88 assertions, exit 0 |
| `/tmp/psx-demo-clean` | `PSX_RENDERING=server php cua psx:build` | exit 0; exit 0 again after the `vendor/` and reachability changes |
| `/tmp/psx-demo-clean` | `SERVER_ADDRESS=tcp://127.0.0.1:8095 PSX_RENDERING=server php cua start`, then `APP_URL=http://127.0.0.1:8095 node --test tests/browser/demo.test.mjs` | 14 tests, 14 pass, exit 0; run again after the `vendor/` and reachability changes with the same result |
| `/tmp/psx-security-check-3vi030sy` | `node vite-json-check.mjs` (coordinator's probe, rerun by me) | exit 1, refused at `config/private.json`, its first case; the cases after it did not run |
| `/tmp/psx-security-check-3vi030sy` | `php server-matrix.php` | exit 255, refused at compilation of the unsafe enum; its other cases therefore did not run again |
| `/tmp/psx-loop-check-f1sp5e2m` | `node client-history.mjs`, `client-auth-lock.mjs`, `client-advanced-revision.mjs` | 1, 1, 0, as explained above |

The helper terminal for port 8095 was removed afterwards; port 8094 answered 200 before and after.

## Framework changes

All additive, recorded in `framework/CHANGELOG.md`, `docs/plugins.md` and `ARCHITECTURE.md`: the `Entered` record, `Router::match()`, strict binding (`Validator` `$strict`, `StrictDecoder::json()`/`plain()`, `Request::exactBody()`). No PHP dependency was added. An application without a package that registers a representation or a decode policy takes none of these paths.

## Outstanding

- **Not independently re-reviewed:** R3-B01 and the removal of the `vendor/` exemption, R1-B04 as redone, R3-S01, R3-C01, R3-C02, the top-level snapshot part of R1-C04, R2-C04, R2-C05, R1-B02, R1-B03, R1-B05, the SameOrigin test, and R1-S06 beyond Codex's two-worker checkpoint.
- **`server-matrix.php` no longer completes**, because its fixture declares the enum the compiler now refuses. Its strict-input, negotiation and preflight cases passed in the coordinator's earlier run and are in `ContractTest`; they were not repeated through that script.
- **Of the refusals before an `auth: true` action runs, only a 422 for input that did not bind says who is signed in.** Any other, such as a 415 or a 406, reconciles the page. That is the safe side and costs a reload.
- Preflight before guards; the renderer slot held by a render that never settles; the reachability check refusing some narrow expressions it cannot see through; no way to import a Composer-shipped front end, pending a decision on the allowlist proposed above.
- No two-tab test of the broadcast; no real-browser test of `auth: true` (the demo logs in by a form post).
- `dev` and client-rendered Chromium runs were not repeated after these fixes.
