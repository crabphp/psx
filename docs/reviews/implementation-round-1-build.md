# PSX implementation review — round 1, build and SSR findings

Stable findings from actual package source and isolated reproductions. No production code or running demo was changed. Paths below are relative to `/home/daudau/Code/crabphp`. Source attribution is the pre-fix snapshot `/tmp/psx-review-baseline-6gjmw6zu`; the scratch JS `dist/` was compiled from the actual pre-fix source. These IDs remain stable in the final round-1 report.

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
