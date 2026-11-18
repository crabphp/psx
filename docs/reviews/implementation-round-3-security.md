# PSX implementation review — round 3, security and integration checkpoint

**Result: the handed-off checkpoint is not accepted as a whole.** The original mutation-provenance defects, document decoding/negotiation defects, ordinary-route preflight bypass, unmarked auth-transition contract, eager worker-service construction, and auth-lock ownership race now pass independent reproductions. Four new counterexamples remain below. Partial-error identity now fails closed, but the previously reported top-level snapshot field loss remains as a fidelity/availability defect.

This is the completed **partial checkpoint** handed over by the coordinator, not a review of the writer's subsequent edits. No production source, live demo, or database was changed by this reviewer. No agent was spawned, and no commit, deployment, or public release was made. Build publication described below occurred only inside a disposable `/tmp` application.

## Attribution and evidence

The reviewed PSX/framework source and tests are preserved at **`/tmp/psx-r3-security-awf9eqi0`**. Paths and line numbers below are relative to that snapshot; they correspond to the same `psx/` and `framework/` paths in the workspace at handoff. `snapshot-sha256.json` records 686 copied files. A final hash comparison found **zero changed snapshot files**. Later production edits are not evidence of what this checkpoint did.

`autoload.php` prepends PSX/test/framework namespace loading from the snapshot, using the installed vendor tree only for dependencies. The PHP matrix prints the resolved implementation paths. The snapshot's actual TypeScript source was compiled into its own `dist/`; the independent browser probes import that build. Browser scheduling uses JSDOM and controlled transport promises. PHP probes compile isolated FixtureApps and traverse the real framework middleware, router, binder and PSX handlers. Real PHP response bodies are also fed through the actual browser runtime.

The coordinator separately reports the full framework regression suite passing: **2,411 tests, 40,375 assertions, 44 skipped, exit 0**. The writer's handoff reported PHP 120 and JS 163 passing tests. Those are attributed suite results, not suites rerun by this reviewer, and do not override the counterexamples below.

## Stable finding disposition

| Stable ID | Checkpoint disposition | Independent evidence |
| --- | --- | --- |
| R1-S01 | **Original mutation finding fixed** | Actual returned Failure resolves `ok:false`; actual thrown/post-next 422 responses carry `entered, expected:false` and `Runtime.act` rejects `RequestFailure(server, unknown)`. Exactly one POST. Before/after middleware return/throw matrix also passes. Read consumers have separate R3-C01 below. |
| R1-S02 | **Original DTO/list/plain-int cases fixed; numeric contract remains open** | Strict nested shape, duplicate, string-coercion and safe-int boundaries pass. Unsafe integer-backed enums bypass the boundary: R3-S01. |
| R1-S03 | **Original finding fixed** | Duplicate and unsafe integer document query fields are refused before loaders. An ordinary route whose path contains `/_psx/` retains ordinary permissive parsing. |
| R1-S04 | **Original finding fixed** | Protocol 99 and supported-protocol/old-build POSTs to an ordinary route are refused before its action. Ordinary non-PSX POST behavior remains unchanged. |
| R1-S05 | **Original finding fixed** | Unmarked `authChanged()` becomes entered/unknown server failure and sends no ActionResult cookie; marked/no-adapter application definition fails; missing/stale revision refuses before entry; current revision enters once and emits next snapshot/cookie. |
| R1-S06 | **Original finding fixed** | Definition and `unmade()` construct no custom AuthState/DocumentRenderer/RendererTransport. Two forked workers each construct each service once on use; parent remains untouched. |
| R1-S07 | **Original finding fixed** | JSON-only Accept and explicit HTML/text q=0 cases refuse with 406 before loaders, including wildcard specificity. Ordinary routes retain their own behavior. |
| R1-B01 | **Original PHP asset vector fixed; broader private-file gate still open** | Original `.psx` URL expression is refused, raw private import is refused, encoded PHP is detected by the real release scanner, public image import succeeds. Normal private JSON modules still publish: R3-B01. |
| R2-C02 | **Original `auth_transition` case fixed** | The refusal immediately clears the page/closes writes, starts one current-credential GET and does not retry the POST. Other unproven auth refusals still fail: R3-C02. |
| R2-C03 | **Original lock-ownership race fixed** | A router subscriber starts transition B as A reconciles. A finishing cannot clear B's lock; unrelated write C is `not-sent`, only two POSTs occur. |
| R1-C03 | **Partially fixed; broader barrier obligation open** | Original barrier and ownership mechanisms pass, but R3-C02 leaves stale protected UI/writes open on another real auth-refusal path. |
| R1-C04 | **Confidentiality counterexamples fixed; top-level field-loss remainder open** | Missing/old identity cannot install private partial nodes. Current/newer nested identity succeeds, including actual PHP-to-browser integration. Current top-level-only identity is still dropped and unnecessarily reconciles. |

R1-B02–B05 and R2-C04/C05 were explicitly **not handed off as complete**. They were not re-reviewed here, even where the source snapshot happened to contain work in progress. R2-C01's previous independent closure and the other round-1 client dispositions are unchanged; this checkpoint does not repeat their whole acceptance matrix.

## R3-B01 — High — Normal imports from private server folders are published as browser modules

**Locations:** `psx/js/src/vite.ts:231–252` (`load`), `278–297` (bundle check); `psx/js/src/private.ts:17–58` (private boundary), `183–223` (PHP-only source hashes), `227–264` (content scan); `psx/src/Commands/PsxBuild.php:100–105`, `157–214` (release scan), `117–137` (publication/selection).

**Trigger:** In an otherwise valid isolated PSX app:

```ts
import secret from '../config/private.json';
console.log(secret);
```

The JSON contains only a synthetic review sentinel. A normal import of `../build/psx/private-manifest.json` is a second independently reproduced path. Neither uses `?raw`, `?url` or `?inline`.

**Observed:** Actual Vite builds both and embeds the private values in public JS. The full standard `php cua psx:build` command also exits 0, publishes assets, and selects isolated release `25ca44c8bcd715aa`. Its `full-build/public/assets/psx/assets/entry-CIY98kG1.js` contains:

```js
console.log({credential:`R3_FULL_PRIVATE_JSON_SENTINEL`});
```

The same checkpoint refuses the original `.psx` asset expression and a `config/private.json?raw` import. Thus the fix addresses those paths but not the private-module boundary.

**Cause:** `secret()` identifies these folders as private, but `load()` acts on that result only for PHP suffixes or raw/url/inline queries. Vite's ordinary JSON transform makes a JS chunk, so the asset-origin check does not apply. The JS fallback fingerprints PHP sources only; the PHP release scanner looks for PHP/module source rather than this transformed private JSON. Both gates permit publication.

**Expected / impact:** Design source privacy (§8, §17 and build acceptance gates) explicitly prohibits private manifests/server material in browser output. An ordinary authored import can accidentally expose private configuration to every browser. This is demonstrated release output, **not** a claim that an unauthenticated attacker can modify application source.

**Evidence:** `vite-check.mjs`, `vite-check.log`, `full-build/`, `full-build.log`. `leak-scanner.php/log` separately proves the encoded-PHP scan now catches the original representation; it does not excuse the JSON module path.

**Fix and regression expectation:** Enforce canonical private-path ownership for all module types before they are read/transformed, preserving the compiler's explicit public component/bindings outputs. Do not special-case only JSON. Check static/dynamic imports, aliases, symlinks, alternate query forms and private build/storage/config manifests with actual Vite and the standard build command. Private input must fail before asset publication/selection; legitimate public images, split components and `?server` bindings must still work. A post-transform byte scan alone cannot reliably reconstruct the provenance of arbitrary transformed modules.

## R3-S01 — Medium — Unsafe integer-backed enums pass binding, projection and output guards and silently round

**Locations:** `framework/src/Validation/Validator.php:362–363`, `510–522`; `psx/src/Compiler/Shapes.php:141–152`; `psx/src/Compiler/TypeWriter.php:45–55`, `66–75`; `psx/src/Runtime/WireCodec.php:87–91`; `psx/js/src/shapes.ts:30–41`.

**Trigger:** Declare an integer-backed enum containing `9007199254740993`. For the collision/output case use:

```php
enum Huge: int {
    case First = 9007199254740992;
    case Second = 9007199254740993;
}
```

Use it as a JSON DTO field, query field, and query return type in compiled PSX operations.

**Observed, separately verified:**

1. JSON `{"value":9007199254740993}` returns 200 and enters the action with that exact unsafe PHP integer (`server-matrix.php`).
2. Query-string `value=9007199254740993` also binds successfully (`enum.php`).
3. Compilation succeeds and generated input/output TypeScript unions and runtime shapes contain the unsafe numeric literals. `enum-generated.d.ts` is a saved excerpt of the actual generated types; `enum-shape.json` holds the actual output shape.
4. A real PHP query returning `Huge::Second` emits JSON `"data":9007199254740993` (`enum-wire.json`).
5. The actual browser `Runtime.read()` accepts it as **9007199254740992**. The two server enum values become the same JS number in the parsed shape (`enum-client.mjs/log`). No protocol failure is raised.

These are observed compiler/input/output/client consequences, not implications inferred only from successful action entry. No business-specific exploit is claimed.

**Cause:** Strict INT/UNION binding checks safe bounds, but ENUM calls an unqualified `enum()` path. The compiler and serializer retain enum backing values without the int branch's bounds; the browser enum validator checks membership against values that have already rounded.

**Expected / impact:** Design §15 rejects integers outside ±(2^53−1), with large precise values represented as strings. A typed operation can currently return a different value to its caller and collapse distinct enum cases.

**Fix and regression expectation:** Reject unsafe numeric enum declarations in PSX input/output projection, enforce strict enum bounds before method entry, and retain defensive output/client validation. Test both signs, list/nested enum fields, JSON/query/form paths, safe boundary values and string-backed large identifiers. Preserve ordinary Crab/PHP numeric enum behavior outside PSX strict decoding. A compiler-only refusal does not replace a strict-binder regression, and a binder-only fix does not prevent output rounding.

## R3-C01 — Medium — Query and navigation consumers ignore explicit unexpected-failure provenance

**Locations:** `psx/js/src/runtime.ts:229–231`; `psx/js/src/protocol.ts:166–202`; `psx/js/src/router.ts:1107–1115`. The action consumer's corrected handling is at `runtime.ts:342–353`.

**Trigger:** A real PSX query or page loader throws `HttpException(422, ...)` after entry. The corrected PHP formatter truthfully returns `kind:'problem', execution:'entered', expected:false`, status 422. Feed that actual body through its corresponding browser API.

**Observed:**

- `Runtime.read()` throws `QueryProblem`, whose API represents an expected refusal. It discards `answer.expected`.
- `router.navigate('/two')` **commits** `/two` and a 422 RouteError state with `navigationError === null`. `Router.load()` reconstructs the problem without checking/preserving the unexpected classification.
- Each probe sends exactly one GET. This is not a mutation retry/outcome issue; R1-S01's original action cases are closed separately.

**Expected / impact:** Design §14 separates unexpected server failures from expected refusal. The imperative query should reject `RequestFailure(kind:'server', outcome:'rejected', status:422)`. Under the documented push-navigation failure contract (§10), navigation should return a failed result carrying that failure, retain the previous page/address and expose `navigationError`; a returned expected loader Failure may still commit the target's error view. UI/error reporting currently receives the wrong semantic path despite explicit server provenance.

**Evidence:** `enum.php` saves a real `query-thrown.json`; `read-provenance.php` saves a real `loader-thrown.json`. `read-provenance.mjs/log` tests both actual consumers; `read-provenance-server.log` records the loader envelope. The initial action-body-to-query probe was followed by these actual query and loader responses before this finding was finalized.

**Fix and regression expectation:** Carry/honor expected-failure provenance in every read consumer, not only actions. Test pre-entry validation and returned Failure as expected positives, thrown/postprocessing 4xx as unexpected negatives, and >=500 behavior. Verify the query cache's error classification and navigation/revalidation behavior while preserving the configured safe-read retry policy and avoiding automatic retries for these 4xx cases.

## R3-C02 — High — An obsolete-credential guard refusal bypasses auth reconciliation

**Locations:** `psx/js/src/runtime.ts:342–359`, `391–399`; `psx/src/Runtime/OperationHandler.php:38–46`, `130–142`; `psx/src/Runtime/Responder.php:192–246`, `270–282` (generic problems carry no current-identity proof).

**Trigger:** A page knows browser revision 5 and has protected data. The server now has revision 6. As required by the auth-adapter contract, application family middleware rejects the old credential before the auth-marked operation runs. It returns a normal 401 problem. This occurs before the generated `OperationHandler::revision()` can produce the special `auth_transition` code.

**Observed:** `auth-server.php` performs a valid transition 5→6, then sends the obsolete revision-5 cookie/expected revision through the same guarded family. The action is not entered. Actual response: `401`, `code:'unauthenticated'`, `execution:'not-entered'`, `expected:true`, no auth snapshot. Feeding this body to the actual auth-marked `Runtime.act()` returns `ok:false`, sends **zero reconciliation GETs**, leaves the old protected page visible, and makes `writable()` true. Exactly one action POST is sent.

The direct `auth_transition` code case now works; `client-check.mjs` positively proves it. This counterexample is the broader invariant that the code-specific correction still misses.

**Expected / impact:** Design §17 requires stale/concurrent/ambiguous auth-transition responses to reconcile. `expected`/`not-entered` proves the method did not make a successful write; it does **not** prove the browser's current identity. A mandatory application credential-revision guard must not disable the client's barrier by returning its normal 401. Protected state remains visible under an obsolete identity and the local write gate reopens.

**Evidence:** `auth-server.php/log`, saved `auth-guard-refusal.json`, and `auth-client.mjs/log`. This is an isolated adapter/guard with synthetic revision cookies, not a real-browser delayed-cookie or transactional-store acceptance test. It demonstrates the concrete valid refusal path and client consequence without assuming an auth middleware omission.

**Fix and regression expectation:** Exempt an auth-marked expected refusal from reconciliation only with **positive validated current-identity and no-change proof**. Preserve the original refusal and never replay the mutation. Do not patch only a status/code allowlist. Generic pre-entry auth errors must not execute protected loaders or assume a request-local authenticated identity that the guard never established. Test this obsolete-credential guard path, missing/old/different identity, concurrent changes and other ambiguous refusals; also positively test a properly proven current no-change business Failure that may safely avoid reconciliation. A plain `expected:true` is insufficient proof of that latter case.

## R1-C04 remainder — Current top-level partial-error identity is still discarded

**Current severity: Medium (fidelity/availability).** The prior demonstrated stale-private-data installation is fixed at this checkpoint; this section does not claim it persists.

**Locations / exact field-loss path:**

1. A problem body carries valid current `auth` beside `kind`, `problem` and same-build `pageError`.
2. `psx/js/src/protocol.ts:191–202` returns `{kind, problem, execution, expected, pageError}` without `auth`; the `Answer` problem variant at `77–86` also has no auth field.
3. `psx/js/src/router.ts:1107–1115` reconstructs only `{kind:'problem', problem, pageError}`.
4. `Router.read()` at `1225` has a top-level fallback, but the field has already been lost. The corrected `admit()` at `690–699` sees no identity and bars the data-bearing partial answer.

**Observed:** Current top-level-only snapshot yields `superseded`, clears the page and starts a reconciliation GET. The identical partial data with current nested `pageError.auth` commits successfully without a GET; a newer same-principal nested snapshot also succeeds. Missing/older-different-principal nested identity clears/reconciles; an older same-principal read is rejected without rolling identity back. `client-check.mjs/log` covers each.

**Integrated positive:** `PageHandler.php:172–186` now attaches the route-local snapshot inside `pageError`. `auth-server.php` records that actual response after an authorized private layout and returned page Failure, and `auth-client.mjs` admits it through the real browser runtime. That integrated server path is fixed.

**Remaining fix/test:** Preserve and validate supported top-level identity through the network control result and router reconstruction. A valid current identity must not be discarded into an unnecessary barrier or document fallback. Keep nested support and the now-correct fail-closed behavior. Test through actual `exchange()`, not just direct bootstrap/`read()` calls.

## Executed checks and limits

All commands below ran in visible hc terminals under the immutable review directory, except the full build whose cwd was `full-build/`. Harness success often asserts an observed defect as well as corrected behavior; **exit 0 does not mean acceptance**.

| Command / artifact | Result |
| --- | --- |
| `node_modules/.bin/tsc -p tsconfig.json` | Snapshot actual-source build succeeds (`psx-r3-build`). |
| `php server-smoke.php`; `php lifecycle.php` | Original server repros corrected; no eager AuthState construction (`server-smoke.log`, `lifecycle.log`). |
| `php server-matrix.php` | Strict shapes/duplicates/plain-int boundaries, ordinary-route preservation, negotiation, global preflight, provenance and unmarked-cookie checks pass; confirms unsafe enum entry (`server-matrix.log`). |
| `node client-check.mjs` | Owner-lock, stale-code barrier, partial-identity matrix and real PHP action outcomes checked (`client-check.log`). |
| `php enum.php`; `node enum-client.mjs` | Confirms enum compile/input/output/rounding defects and actual query classification (`enum.log`, `enum-client.log`). |
| `php auth-server.php`; `node auth-client.mjs` | Two-worker lifecycle, auth contract/revision/cookie checks, actual partial identity integration; confirms obsolete-credential refusal gap (`auth-server.log`, `auth-client.log`). |
| `php read-provenance.php`; `node read-provenance.mjs` | Actual query and loader unexpected responses follow expected-refusal UI paths (`read-provenance-server.log`, `read-provenance.log`). |
| `node vite-check.mjs` | Original URL/raw private inputs refused; private JSON/manifest imports leak; public image succeeds (`vite-check.log`). |
| `php cua psx:build` in isolated `full-build/` | Standard compile/typecheck/Vite/release command succeeds and publishes private JSON sentinel (`full-build.log`). |
| `php leak-scanner.php` | Actual release scanner catches synthetic encoded PHP (`leak-scanner.log`). |

The first PHP-to-browser partial probe had a scratch manifest typo (`fields` instead of `props`); only that harness was corrected, then the probe passed. This was not a production defect. All four new findings have final passing reproductions of their stated observed behavior.

Coverage limits: no live demo changes; no real-browser multi-tab Set-Cookie race or production transactional auth adapter certification; no exhaustive Unicode/charset/multipart/prototype/depth fuzzing; no complete Vite-plugin composition proof. Public/session-only origin protection remains the previously adjudicated application configuration/documentation obligation, not a newly demonstrated CSRF vulnerability from an unguarded fixture. The ordinary-route compatibility cases and full framework suite do not certify every custom middleware or PSR request implementation. Pending development/SSR/compiler/history batches require their own completed handoff and re-review.

For the next auth checkpoint, the acceptance invariant is positive proof of current identity/no change for any no-barrier refusal, with both a stale/ambiguous negative case and a proven-current business-failure positive case. No mere status/code classification or suite pass substitutes for those observations.
