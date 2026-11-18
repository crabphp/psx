# PSX Implementation Review — Round 4 Final-Fixes Verification

**Date:** 2026-11-15  
**Reviewer:** Codex CLI (`gemini-4-argon-high`, `high` reasoning for Round 4; mixed session after Rounds 1–3 ran on `gpt-6-astra`, `max` reasoning)  
**Handoff:** `/home/daudau/Code/brainstorm/psx/FINAL-FIX-REVIEW-HANDOFF.md`  
**Immutable Snapshot:** `/tmp/psx-r4-final-j7fxo3_0` (705 files hashed in `/tmp/psx-r4-final-j7fxo3_0/snapshot-sha256.json`; verified 0 mismatches before and after all harnesses across both the snapshot and `/home/daudau/Code/crabphp`)

---

## 1. Executive Verdict

1. **Verdict on the Round 1–3 Fix Batch:** **Substantially Closed (18 of 19 prior items fully fixed and verified; 1 narrow compile-time schema-walker edge case `R4-S01` identified in `R3-S01`).**
   - Every security, provenance, auth-barrier, strict-input, Vite/publish boundary, dev-compile atomicity, SSR socket concurrency, route-reachability proof, namespace-collision, and browser-history alignment fix handed off in `implementation-round-1-server-build-fixes.md` was independently verified from source and through isolated positive and negative harnesses in `/tmp/psx-r4-final-j7fxo3_0`.
   - One narrow compile-time edge case (**`R4-S01`**, Low/Medium severity) remains in `psx/src/Compiler/Families.php:353–370`: `Families::exact(?array $schema, ...)` checks `if ($key === 'enum' && is_array($value))` and only recurses in `elseif (is_array($value))`. When an input DTO property or `#[FromQuery]` parameter is literally named `$enum`, `$schema['properties']['enum']` has key `'enum'` whose value is a property sub-schema map (`['type' => 'integer', 'enum' => [...]]`) rather than a list of enum cases, skipping recursion at compile time and emitting unsafe integer literals into `.psx/types/...`. Runtime `Validator::enum()` (`strict: true`) still rejects unsafe integer values with `422 not-entered`, so no unsafe value reaches the handler. Changing line 356 to `if ($key === 'enum' && is_array($value) && array_is_list($value))` closes the gap completely.
2. **Scoped Fix Acceptance vs. Production Readiness:**
   - **Fix-batch acceptance:** Once the one-line `R4-S01` guard in `Families::exact()` is applied (with a regression test for a property/parameter named `$enum`), all Round 1–3 review findings (`R1-C01`..`C07`, `R2-C01`..`C05`, `R3-C01`..`C02`, `R1-S01`..`S07`, `R3-S01`, `R1-B01`..`B05`, `R3-B01`) are resolved.
   - **Production readiness distinction:** As noted in Section 6, full production readiness remains distinct from this scoped fix batch only with respect to broader end-to-end browser coverage outside these unit/integration harnesses (real multi-tab `BroadcastChannel` E2E coverage and real-browser `#[Action(auth: true)]` E2E coverage). The strict `vendor/` boundary (no imports from `vendor/`, directly or via symlinks, and no allowlist feature now) is an intentional, settled design decision.

---

## 2. Immutable Snapshot Inventory & Key SHA-256 Hashes

All 705 files in `/tmp/psx-r4-final-j7fxo3_0/snapshot-sha256.json` were verified before and after running all harnesses (`checked=705 mismatches=0`). Key source files reviewed in this checkpoint:

| File | SHA-256 |
| --- | --- |
| `psx/js/src/private.ts` | `d00759b7b86b1e55ee166d78fa01e186661d480c6d8eaf7a849d2c3382b53b05` |
| `psx/js/src/vite.ts` | `24ee5df453e583e2018354ada9399469ca501a33f86c72f1b35986dac60f78a4` |
| `psx/js/src/socket.ts` | `3402abc8de332c1ac17afd2e49d94500214d004a51610561819c59d13e922bb3` |
| `psx/js/src/protocol.ts` | `6d749a817d5ac6ebc56f0744e520df1611881a9cc34eb86aa936ba38032218ed` |
| `psx/js/src/runtime.ts` | `d44721ce9b82df47dabb70f118e166c76e0194170ed651fc4ffaa3784b6d4948` |
| `psx/js/src/router.ts` | `6706d360f4818412b606db08f62164aafee2776c7ed4afbbbb495caf18fc6bf7` |
| `psx/js/src/shapes.ts` | `bfc0771e383c303829f9db440ad2adcb8539bf9ea95ab4e464eb29b1b1ef115c` |
| `psx/src/Commands/PsxBuild.php` | `e0c520b66b101b3ce22220766dc102f4deb9948c3a3e5695d0f125a11c4d2914` |
| `psx/src/Commands/PsxCompile.php` | `3f24ded30c75b0398ba0d5836a1fa362a9eff8f4b5df97df9c99d5d75623bc14` |
| `psx/src/Commands/PsxVerify.php` | `eb00f7e99e6a8d5ca1c2893f6aa5cecc982a9861844e8707661055427309a3d2` |
| `psx/src/Compiler/Addresses.php` | `7f5cfb6f818a9b4246626e16f34cd55e274f3f10becd2a96c72e4f68aeabe966` |
| `psx/src/Compiler/Compiler.php` | `7a777ac1ca0c5e83ed1d012eb1dc1e0de1de352b4ed68ad9808610c64314b82e` |
| `psx/src/Compiler/Families.php` | `31e8dfcadef6098d3e390d72a0576bfd0047f82b394511b92ddf50fcce91ea4b` |
| `psx/src/Compiler/Shapes.php` | `fb87de4d4cf378f8212b5a64a5105c9ec870a1869ac3a305fd0915950912a015` |
| `psx/src/Runtime/OperationHandler.php` | `56f1efc5758855d59ecac08584626a042acd4818eaa1ee3a8e0c8f2e4affac0f` |
| `psx/src/Runtime/PageHandler.php` | `0d131fd275af8d0b24f2b13135bbc260a6d4837158347e745d13170c48b29511` |
| `psx/src/Runtime/Preflight.php` | `4d40dffdfe5c556216e4b1e82ea365e26d726f564730b651d2fdae7cfcfb0fc0` |
| `psx/src/Runtime/PsxDefinition.php` | `f7b63d3ab8dbd8892b562b8e9b3d0e1c249106b47b09a92f5a1d596e27515268` |
| `psx/src/Runtime/Responder.php` | `e2d71fced88350bae89ca5073de1d6235dea63d11d0764700895183de6004dd6` |
| `psx/src/Runtime/Services.php` | `1d0bab766a65088d8304ad4886487287b2802dbff3dcc40ccd0f4e35706b7247` |
| `psx/src/Runtime/WireCodec.php` | `fdabc99b9d4cc0525448bf9f4749ccb21722f7fcdbb1c8430794400315d15b95` |
| `framework/src/Validation/Validator.php` | `e5df6de1788240f91989bcffdf37e593cd91028bf39e2e7bce61477931886db3` |
| `framework/src/Http/StrictDecoder.php` | `b8ee7baa08267b4e31b79846d5f240befd64b057b8f7c74dd562420ead15e61f` |
| `framework/src/Http/SelectDecoding.php` | `5821c0d1cab4fd004e8276f9927506e55e3fd9810b6f17e3a88d4b8e9a23292f` |
| `framework/src/Http/RenderedErrors.php` | `496d970d81867dad4ecc26d703ae0413eb48f0a55871c6aaf53550d6c5b49955` |
| `framework/src/Routing/ActionHandler.php` | `78101edcadf2d16845719d31c114bccf60dd5ddf747f2f0b74058d4bb0995490` |
| `framework/src/Routing/Router.php` | `3da6a360e6707b88b406e4c4dfc73a0f60adf484a07cba302b661f11f7ae673e` |

---

## 3. Per-ID Verification Summary

| ID | Area | Status | Independent Verification Summary |
| --- | --- | --- | --- |
| `R3-B01` / `R1-B01` | Vite private-file & `vendor/` boundary + publish gate | **FIXED** | `vite.ts::load()` and `generateBundle()` refuse all private paths (`config/*.json`, `build/*.json`, `.psx?url`, `.env?raw`, `vendor/` even with `package.json`, and `node_modules/` symlinks into `vendor/`) and write `.vite/psx-inputs.json`. `PsxBuild::inputs()` independently re-verifies and deletes `.vite/psx-inputs.json` before publishing. Real `node_modules` packages, public assets, and split `.psx` client components build cleanly. |
| `R3-S01` / `R1-S02` | Strict input & safe-integer enum boundary | **PARTIAL (`R4-S01`)** | `Validator::enum()` (`strict: true`), `Shapes::ofClass()`, `WireCodec::encode()`, and client `shapes.ts::mismatch()` all reject integer-backed enum values outside `±9007199254740991`, while non-strict `Validator::validate(..., strict: false)` preserves ordinary PHP integer-backed enums. However, `Families::exact()` (`Families.php:356`) misses unsafe integer-backed enums at compile time when the DTO property or query parameter is named `$enum` (see `R4-S01`). |
| `R3-C01` / `R1-S01` | Failure provenance across actions, queries, and loaders | **FIXED** | `exchange()` (`protocol.ts:116–128`) throws `RequestFailure('server', ...)` whenever `!(execution === 'not-entered' \|\| envelope.expected === true)`. Thrown 422 in action -> `RequestFailure(outcome='unknown')`; thrown 422 in query -> `RequestFailure(outcome='rejected')`; thrown 422 in page loader -> `navigate()` returns `{ status: 'failed' }`, keeps current page/URL, sets `navigationError`. Returned `Failure` stays expected. |
| `R3-C02` / `R2-C02` / `R2-C03` | Auth transition refusal provenance & lock ownership | **FIXED** | `OperationHandler` sets `['witnessed' => true]` only after route/operation guards and `revision()` succeed. Guard 401/403 and stale revision 409 carry no `auth` snapshot; `Runtime.act()` synchronously closes the write gate and active page, performs 1 reconciliation GET and 0 POST retries, and returns `{ ok: false, problem }`. Witnessed current 422/Failure keeps page and draft state with 0 GETs. Owner lock (`R2-C03`) holds across overlapping transitions. |
| `R1-C04` | Partial error envelope auth provenance | **FIXED** | `exchange()` preserves top-level `auth` when `respondingBuild === request.build`; `RouterCore.load()` and `whose()` accept top-level-only, nested-only, or matching top-level + nested snapshots, and fail closed (`null` -> `superseded` + reconciliation) when missing or contradictory. |
| `R2-C04` | Document fallback `replace: true` | **FIXED** | `RouterCore` passes `intent.type === 'replace'` (and `replace \|\| loaded.replace` on redirects) to `leave(href, replace)`, which calls `window.location.replace(href)` when `replace` is true and `window.location.assign(href)` when false. |
| `R2-C05` | Overtaken Back/Forward history alignment | **FIXED** | `physical()`, `realign()`, and `expectPop` realign `this.index`, `history.state.psx.index`, `key`, `location.pathname`, and active page when an in-flight `popstate` traversal is overtaken by `navigate()` and when a subsequent Back is blocked and then allowed. |
| `R1-B02` | `psx:compile` fresh-process verification | **FIXED** | `PsxCompile` compiles with `publish: false`, runs `psx:verify --release=$stage` in a fresh PHP process (including `App::current()->unmade()`), and only publishes `.psx/` client files and updates `build/psx/dev/current` after verification exits 0. |
| `R1-B03` | SSR socket slot retention & bounded queue | **FIXED** | `socket.ts` holds `inflight` in `.finally()` until `options.render()` settles, bounds waiting jobs to `maxQueue`, and removes timed-out or disconnected queued jobs in `settle()` so they never invoke `options.render()`. |
| `R1-B04` | Catch-all & route shadowing proof | **FIXED** | `Addresses::shadows()` proves route disjointness segment-by-segment without sample probing. `Families::reachable()` refuses page paths that shadow their own queries (while admitting suffix-disjoint paths like `/tree/{tail:.+}/view`), and `PsxDefinition::add()` refuses earlier parameterized routes (including ordinary routes) that shadow parameterized PSX operations. |
| `R1-B05` | Case/punctuation module namespace collisions | **FIXED** | `Compiler::compile()` checks `strtolower($source->namespace)` before writing or `require`-ing any generated PHP file, throwing a deterministic `PsxException` naming both source files. |
| `R1-S03`..`S07`, `SameOrigin` | Duplicate query keys, preflight, unmarked `authChanged`, worker services, HTML negotiation, `SameOrigin` | **FIXED** | Verified in `r4-server.php` and `ContractTest`. |

---

## 4. Detailed Findings & Evidence

### `R4-S01` (Low/Medium) — `Families::exact()` skips compile-time safe-integer enum check when an input DTO property or query parameter is named `$enum`

- **Location:** [Families.php](/home/daudau/Code/crabphp/psx/src/Compiler/Families.php:353) (`psx/src/Compiler/Families.php:353–370`)
- **Mechanism:**
  ```php
  private static function exact(?array $schema, string $method, Declaration $declaration, ?int $line): void
  {
      foreach ($schema ?? [] as $key => $value) {
          if ($key === 'enum' && is_array($value)) {
              foreach ($value as $case) {
                  if (is_int($case) && abs($case) > Shapes::SAFE) {
                      throw new PsxException(...);
                  }
              }
          } elseif (is_array($value)) {
              self::exact($value, $method, $declaration, $line);
          }
      }
  }
  ```
  In JSON Schema generated for an action input class or query signature, object properties live under `$schema['properties'][<propertyName>]`. When a DTO property or `#[FromQuery]` parameter is named `$enum` (for example, `public LocalHugeNamedEnum $enum` or `#[FromQuery] LocalHugeNamedEnum $enum`), the entry in `$schema['properties']` has `$key === 'enum'` and `$value === ['type' => 'integer', 'enum' => [9007199254740992, 9007199254740993]]`. Because `$key === 'enum' && is_array($value)` matches that property entry, `Families::exact()` loops over the property schema's top-level values (`'integer'` and `[9007199254740992, 9007199254740993]`, neither of which satisfies `is_int($case)`) and skips the `elseif (is_array($value))` recursion.
- **Concrete Repro & Observed Output (`/tmp/psx-r4-final-j7fxo3_0/r4-server.php`):**
  Declaring `enum LocalHugeNamedEnum: int { case Safe = 9007199254740992; case Unsafe = 9007199254740993; }` on `final readonly class NamedEnumInput { public function __construct(public LocalHugeNamedEnum $enum) {} }` and `#[Query] public function look(#[FromQuery] LocalHugeNamedEnum $enum): string` compiles without throwing `PsxException` and writes the unsafe integer literal `9007199254740992 | 9007199254740993` into `.psx/types/pages/Check.ts`:
  ```
  R4_S01_CONFIRMED: property/parameter named $enum bypassed Families::exact() compile-time check; unsafe literal in operations.d.ts=true
  ```
- **Actual Impact & Mitigation Already Present:**
  Runtime input binding in `Validator::enum()` (`framework/src/Validation/Validator.php:271`) still rejects `9007199254740993` with `422 not-entered` when `$strict === true`, and `Shapes::ofClass()` / `WireCodec::encode()` still reject unsafe integer enums on output. The bypass is strictly limited to the compile-time declaration check and generated TypeScript input types when a parameter/property is named `$enum`.
- **Required Fix:**
  In `psx/src/Compiler/Families.php:356`, check `if ($key === 'enum' && is_array($value) && array_is_list($value))` so property sub-schemas keyed by `'enum'` fall through to `elseif (is_array($value))` and recurse into their nested `'enum'` case list.

---

## 5. Commands Run & Verification Results

All commands were executed in visible `hc` terminals without touching the live demo on port `8094` or Vite `5173`:

1. **Snapshot TypeScript Build (`psx-r4-build`, `t2pj`):**
   - Command: `/home/daudau/Code/crabphp/psx/js/node_modules/.bin/tsc -p /tmp/psx-r4-final-j7fxo3_0/tsconfig.json`
   - Result: `exit 0`
2. **Isolated Server & Compiler Verification Matrix (`psx-r4-server-pass`, `t2qf`):**
   - Command: `php /tmp/psx-r4-final-j7fxo3_0/r4-server.php`
   - Result: `exit 0` — 27 positive and negative assertions passed across `Validator` (strict vs non-strict), `Shapes::ofExpression`, `WireCodec::encode`, `Addresses::shadows`, `R3-S01` compile-time rejection (output, DTO input, `FromQuery` input), `R4-S01` `$enum` property-name repro, `R1-B04` compile-time and runtime catch-all/suffix proof, `R1-B05` hyphen/underscore and case-insensitive namespace collisions, `R1-S04`/`S05` preflight before ordinary routes, `SameOrigin` guard, `R1-S03` duplicate query keys, `R1-S07` HTML `Accept` negotiation, `R1-S02` strict JSON input decoding, `R1-S01` / `R3-C01` action/query/loader failure provenance, `R1-C04` partial error auth snapshot, and `R3-C02` / `R1-S05` auth transition witnessed/unwitnessed/unmarked invariants.
3. **Isolated Client & Wire-Envelope Integration Matrix (`psx-r4-client-pass7`, `t2r4`):**
   - Command: `node /tmp/psx-r4-final-j7fxo3_0/r4-client.mjs`
   - Result: `exit 0` — 23 positive and negative assertions passed consuming the real PHP wire envelopes generated by `r4-server.php` across `R1-S01`, `R3-C01`, `R3-C02`, `R2-C02`, `R1-C04`, `R2-C04`, `R2-C05`, and `R3-S01`.
4. **Isolated Vite Boundary & SSR Socket Concurrency Harness (`psx-r4-vite-ssr-pass`, `t2rs`):**
   - Command: `node /tmp/psx-r4-final-j7fxo3_0/r4-vite-ssr.mjs`
   - Result: `exit 0` — 12 positive and negative assertions passed across `R3-B01` / `R1-B01` (`config/private.json`, `build/psx/private-manifest.json`, `.psx?url`, `.env?raw`, direct `vendor/` with `package.json`, `node_modules/` symlink to `vendor/`, clean `node_modules/` package + SVG + split `.psx`, `.vite/psx-inputs.json` generation) and `R1-B03` (SSR socket `maxInflight=1`, `maxQueue=1`, timeout slot retention, queued timeout eviction, and recovery).
5. **Isolated `psx:compile` Fresh-Process Verification & `PsxBuild::inputs()` Gate (`psx-r4-build-dev-pass7`, `t2s6`):**
   - Command: `php /tmp/psx-r4-final-j7fxo3_0/r4-build-dev.php`
   - Result: `exit 0` — 11 positive and negative assertions passed across `R1-B02` (route collision and unmade service dependency fail `psx:compile` without updating `build/psx/dev/current` or `.psx/` browser files; subsequent fix advances both coherently) and `R3-B01` (`PsxBuild::inputs()` rejects private/vendor/symlinked-vendor/missing/malformed manifests and unlinks valid `.vite/psx-inputs.json`).
6. **Repository Test Suites (`psx-r4-suites2`, `t2s8`):**
   - `psx/vendor/bin/phpunit`: `OK (164 tests, 1087 assertions)`, `exit 0`
   - `psx/js` `npm test -- --run`: `5 passed (5), 222 passed (222)`, `exit 0`
   - `psx/js` `npm run typecheck`: `exit 0`
   - `psx-demo/vendor/bin/phpunit`: `OK (6 tests, 88 assertions)`, `exit 0`

---

## 6. Remaining Coverage Limits & Architectural Tradeoffs

1. **`R4-S01` (`Families::exact()` `$enum` property/parameter name):** Requires the 1-line `array_is_list($value)` check in `psx/src/Compiler/Families.php:356` and a unit test in `CompilerTest`.
2. **Settled `vendor/` boundary decision:** Removing `packaged()` closes the `vendor/` exposure vector completely. Refusing all `vendor/` files (directly or via `node_modules` symlinks, without a `vendor/` allowlist feature) is a settled architectural decision for PSX, not an open requirement.
3. **Pre-binding refusal types on `#[Action(auth: true)]`:** Among pre-entry refusals on `auth: true` actions, only binder 422 (`Responder::unbound()`) carries `witnessed => true`; other pre-entry protocol/negotiation refusals (such as 415 or 406) trigger fail-closed auth reconciliation.
4. **End-to-end browser coverage:** Multi-tab `BroadcastChannel` auth synchronization and real-browser `#[Action(auth: true)]` transitions remain covered by JSDOM/unit suites rather than Chromium E2E tests.

