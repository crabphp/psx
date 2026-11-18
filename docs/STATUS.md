# Implementation status

Version 0.2.0, released 2026-11-18; the test evidence below is from 2026-11-15, with the PHP and TypeScript suites rerun on 2026-11-18. This file records what was built from [DESIGN.md](DESIGN.md), what proves it, where the implementation differs from the design, and what is missing. The design itself is copied from `brainstorm/psx`, with two deliberate changes since: on 2026-11-17 the PHP of a `.psx` file moved from `<?php` … `?>` to a `<script lang="php">` block, and on 2026-11-18 from a hand-written `Server` class to functions with `#[Inject]` services (section 4 and its examples). Nothing was removed from it to make this list shorter.

**This is not a production release.** Section 26 of the design lists the acceptance gates; the last table here says which have an automated proof. The readiness pass of 2026-11-15, its evidence, measurements, limits and what is still open are in [reports/production-readiness.md](reports/production-readiness.md).

## Milestones

| | Milestone | State |
| --- | --- | --- |
| 1 | Framework contracts (design section 25) with ordinary-Crab regression tests | Done |
| 2 | Compiler: source format, shapes, type projection, public/private artifacts, negative fixtures | Done |
| 3 | Runtime: registry, route families, protocol, document, loaders, queries, actions, errors | Done |
| 4 | npm package: router, immutable scopes, query cache, bindings, forms, Vite plugin | Done |
| 5 | Developer workflow: `psx:init`, `dev`, `psx:check`, `psx:build`, `psx:list`, `psx:types` | Done |
| 6 | Server rendering: renderer bundle, supervised process, socket protocol, development renderer | Done |
| 7 | Demo application with PHP and real-browser tests, client and server rendering | Done |
| 8 | Editor extension | Not started |
| 9 | Full acceptance matrix, measured budgets, pinned release | Matrix and measurements done ([report](reports/production-readiness.md)); nothing pinned or released, and the pass is not independently reviewed |

## Test evidence

| Suite | Command | Result on 2026-11-15 |
| --- | --- | --- |
| Framework | `composer test` in `framework/` | 2412 tests, 44 skipped as before; 40393 assertions in my run and 40391 in the coordinator's later one |
| PSX, PHP | `composer test` | 179 tests, 1238 assertions |
| PSX, TypeScript | `npm test` in `js/` | 261 tests |
| Acceptance, real Chromium against the packed packages | `node run.mjs --mode=all` in `tests/acceptance/` | 65 tests in each mode. Built, browser-rendered: 52 pass, 13 skipped. Built, server-rendered: 60 pass, 5 skipped. `dev`: 48 pass, 17 skipped. No failure; a skipped test belongs to another mode |
| Demo, PHP | `composer test` in `psx-demo/` | 6 tests, 88 assertions |
| Demo, Chromium | `node --test tests/browser/demo.test.mjs` | On a separate copy and port. Built, browser-rendered: 13 pass, 1 skipped. Built, server-rendered: 14 pass. `dev`: 13 pass, 1 skipped |

Lint and format: `mago lint` and `mago fmt --check` clean for `psx/`; `prettier --check` and `tsc --noEmit` clean for `js/`; the framework's format check is clean and its lint reports three hints in files this work did not touch.

## Feature matrix

"Tested" names the kind of proof: **P** PHPUnit through the application's real router and middleware, **J** Vitest, **B** real Chromium against the demo, **M** checked by hand once and recorded in the report.

### Language and compiler

| Feature | Implemented | Tested |
| --- | --- | --- |
| `.psx` split: leading `<script lang="php">` block, TSX below, line numbers kept | Yes | P |
| PHP strings, comments, heredocs holding `</script>`; TSX generics and comparisons | Yes | P |
| The earlier `<?php` … `?>` form, a `?>` in the block, PHP below it, extra attributes: refused with file and line | Yes | P |
| Functions: `load()`, `#[Query]`, `#[Action]`; services as `#[Inject]` parameters; `$this` and a hand-written `Server` class refused; the class the router calls made by the compiler, errors on the function's line | Yes | P |
| Local classes, enums, functions and constants namespaced per file, no collisions | Yes | P |
| Shapes: scalars, dates, backed enums, nullable, `#[ListOf]`, `#[MapOf]`, readonly DTOs; `mixed`, untyped arrays, recursion refused with file and line | Yes | P (46 compiler tests, negative fixtures) |
| `@return PageData<T>|Failure|Redirect` and the like read from the docblock | Yes | P |
| Generated TypeScript: props, input and output types, `@psx/routes`, `@psx/services`, bindings | Yes | P, and `tsc` on the demo |
| `$name` bindings in scope; a TSX declaration of the same name refused | Yes | P |
| `X.psx?server` imports; raw or `?raw` import of a `.psx` refused | Yes | M (TypeScript and Vite both, in a clean copy of the demo) |
| Private PHP and manifest under `build/`, public TSX and types under `.psx/` | Yes | P, B |
| Leak scan of built scripts for PHP of the pages | Yes | P; B checks every response body the browser receives |

### Server

| Feature | Implemented | Tested |
| --- | --- | --- |
| Explicit `page()`, `layout()`, `service()`, groups, names, per-operation guards | Yes | P |
| `Psx::page()` and the rest from the application's route files; short names (`'Posts/Edit'`) resolved in the folder of each kind; `routes/pages.php` optional | Yes | P; `psx:list` and `psx:check` checked by hand on a copy of the demo |
| Route family as ordinary Crab routes; collisions with application routes refused | Yes | P |
| Guard order: group, layouts outer first, page, operation; same middleware objects | Yes | P |
| Loaders in order; a redirect or failure stops the chain and sends nothing of later loaders | Yes | P |
| One composite query schema per address; each loader reads its own fields | Yes | P |
| Typed binding and validation by Crab's own binder (`Actions::prepare`) | Yes | P |
| Strict decoding and binding on PSX routes only: duplicate fields, non-object JSON, object against list, integers and integer enums within ±(2^53 − 1) in JSON, forms, query and path | Yes | P, and the framework's `StrictDecoderTest` and `PackageContractsTest` |
| Protocol and build checked before routing (`Preflight`); a document that does not accept HTML is 406 | Yes | P |
| `execution` taken from the framework's record of entry, also for middleware that throws or answers after the action | Yes | P |
| Explicit `SameOrigin` guard for an action with no login | Yes | P |
| Protocol `psx/1`: build, schema and protocol headers; stale build never enters an action | Yes | P |
| Expected failures, redirects, `execution: entered` or `not-entered`, `pageError` | Yes | P |
| Wire values checked against the declared shape before sending | Yes | P |
| Uploads as multipart forms; an action with a file refuses JSON with 415 | Yes | P (demo), B |
| Document: escaped bootstrap, head, assets from Vite or the release manifest | Yes | P, B |
| `#[Action(auth: true)]` with `AuthState` revisions | Yes | P with a fake `AuthState`; B with a real one in the acceptance application |
| Ordinary routes and their errors unchanged beside PSX | Yes | P, framework suite |

### Browser runtime

| Feature | Implemented | Tested |
| --- | --- | --- |
| Client router: links, history, redirects, latest navigation wins | Yes | J, B |
| Layout kept across navigation; page keyed by route and parameters | Yes | J, B |
| Immutable scopes; a late call still targets its own page; forged scope refused | Yes | J, B |
| `ifCurrent` navigation; navigation blockers | Yes | J, B |
| Actions as JSON and as forms; `useActionState`; controlled drafts kept on failure | Yes | J, B |
| No mutation retry; lost answer, proxy page, wrong shape are `RequestFailure` | Yes | J |
| `useQuery`: one request for equal keys, tags, invalidation, refetch, error state | Yes | J, B |
| Query cache bounds and garbage collection; read-ahead bounds and invalidation | Yes | J |
| Build mismatch leaves for a fresh document | Yes | J |
| Auth change clears caches and reconciles; cross-tab broadcast | Yes | J, B with two real tabs |
| `RouteError`, `ErrorBoundary`, `Pending` exports | Yes | J, B |
| Scroll and focus restoration, hash navigation, `prefetch` | Yes | B for scroll, focus and hash; J for `prefetch` |
| `clientOnly()` | Yes | B |
| Shape check of every answer; prototype keys, unsafe integers, depth | Yes | J |

### Workflow and deployment

| Feature | Implemented | Tested |
| --- | --- | --- |
| `php cua dev`: compile, Vite, readiness, one terminal | Yes | B |
| TSX edit refreshed in place; PHP edit restarts and reloads; a page added and deleted; a broken file keeps the last server and its scripts | Yes | B |
| `psx:init` keeps existing files, `--force` | Yes | P |
| `psx:list`, `psx:types`, `psx:check` | Yes | P for the first two; `psx:check` M |
| `psx:build`: staged, verified, typechecked, built, leak-scanned, then selected atomically | Yes | B: six kinds of failing build select and publish nothing |
| `start` refuses to serve without a release | Yes | P |
| Vite dev server refuses `.psx` and `.php` requests | Yes | B |
| Server rendering: production renderer over a private socket, bounds, release check; a renderer for each server process, ready before the server answers or the server does not start, serving until its workers have stopped | Yes | P against real Node, J, B |
| Server rendering under `dev` through Vite | Yes | M |
| Releases: reload, a tab of an earlier release, rollback, retained scripts | Yes | B |
| Content-Security-Policy with a nonce, browser- and server-rendered | Yes | B, P |

## Deviations from the design

| Design | Implementation | Why |
| --- | --- | --- |
| A schema id per route for navigation | One navigation schema for the whole build | The server decides which page an address is. A per-route id would refuse a navigation the client matched differently |
| `RouteScope<'routeName'>` | Branded by mount id, such as `'posts.edit/page'` | One module can be mounted by several routes; the mount is what an operation is bound to |
| An npm CLI | None. The commands are `php cua psx:*` | The compiler is PHP; a second entry point would only forward to it |
| `psx()` Vite plugin "consumes the staged manifest path" | Reads `.psx/` and the `PSX_*` environment `dev` and `psx:build` set | Same intent; running Vite alone still fails with the command to run |
| `ActionResult::authChanged()` carries the new snapshot | It says only that it changed; the client reloads the page to learn who it is | One source of truth for identity, the page |
| `psx.ssr.socket` is resolved for each immutable release | For a renderer the server runs itself, also for each server process: `ssr-{build}.{pid}.sock`. One it does not run keeps the name as set | Two servers of one release run side by side during a reload; sharing one path let one remove the other's socket |
| `RendererTransport::render(array $envelope)` | `render(array $envelope, ?string $nonce = null)` | React's inline script in server markup needs the document's nonce under a strict policy |
| TypeScript 5.9 baseline | Built and tested with TypeScript 7.0, Vite 8.3, React 19.2, Node 24 | What is installed here. Older versions are untested |

## Known gaps and risks

- **Review state.** The rounds 1–4 fix batch is accepted for the reviewed scope: [round-4 verification](reviews/implementation-round-4-final-fixes.md) and the [final R4-S01 re-check](reviews/implementation-round-4-recheck.md) close the identified findings. The final independent harness passed; the coordinator recorded its result after a reviewer transport error. This is not production approval: the remaining acceptance gates below still apply. Earlier fixes remain recorded in [the server/build report](reviews/implementation-round-1-server-build-fixes.md).

- **No separate reviewer has gone over the readiness pass as a whole.** It changed production code in the router, the start-up, the query cache and the renderer's lifecycle; see the report for the list. The coordinator reviewed the lifecycle and cache changes, found and rechecked three defects in them, reran READY-C01 to C03 and ran the complete suites on the final source.
- **Fixed after 0.1.0: a renderer outliving its server.** A renderer the server runs is started with `--exit-with-parent` and stops within about a second of the process that started it being killed outright. A renderer whose address was taken by the one started in its place no longer removes that one's socket when it stops: closing a listening socket removes the file at its path, whosever it is now. Proven by Vitest (the watch, and two renderers at one path) and by a real renderer whose parent was killed with `SIGKILL`: it stopped 0.95 s later and removed its socket, where one without the flag kept running. The whole-server reproduction of the report was not run again.
- **Untested design gates**: Arc pages and a custom error renderer beside PSX; a 429 from the application's own rate limit.
- **One call is not one delivery.** PSX sends a write once. A browser was seen to send a `POST` again by itself when a reused connection died before any answer; an operation that must happen once needs an idempotency key of the application's own.
- **Tested on one Linux machine with Chromium only.**
- **No editor extension.** A `.psx` file has no language support. Types are checked on the generated `.psx/client/*.psx.tsx`, whose line numbers match the source; an error names the generated file.
- **No pinned artifact.** The demo and the tests install from path repositories. A deployment needs a versioned, pinned build of both packages and lock files in the application; publishing is not required for that.
- **Windows is unsupported**: the generated `X.psx?server.ts` cannot exist there.
- **`tsconfig.json` must name `.psx/**`** explicitly. A bare `".psx"` in `include` is skipped by TypeScript and nothing is checked; `psx:init` writes the correct form.
- **Preflight runs before route guards.** A request that names the protocol with a wrong or missing build is answered 409 before authentication or `SameOrigin` see it. Nothing is entered either way; the status a guard would have given is not the one sent.
- **Actions with no login have no guard unless the application names one.** `CookieAuth` checks the origin; a public page's action needs `->operation(name, SameOrigin::class)`. Documented in the README and tested; the scaffold has no such action.
- **Reachability**: a query or an action that a route declared before it might answer is refused unless the two patterns are proven apart, by their segments and never by sample addresses. This is conservative: an expression that is narrow but not spelled from letters, digits, `_`, `.`, `-`, `\d` and `\w` is refused too. Page documents follow the router's ordinary precedence and are not checked.
- **A renderer that stays down can stop the whole server.** A worker started while a running server's renderer is down does not start until the renderer is back; the other workers answer `503` for pages and go on answering the rest. Six such failed starts in a minute stop the server, which is the framework's rule for any worker, and that takes routes that render nothing with it. It is deliberate: a worker never serves without its renderer. The README has what to watch and how to recover; `'rendering' => 'client'` is not affected.
- **A render that never settles** holds its renderer slot until the process is restarted; the queue is bounded and a queued job past its deadline is dropped, but a running render is not cancelled.
- **Scripts from `vendor/`**: none may be imported, also not through a link from `node_modules/`. A front end shipped by a Composer package has no supported way in; an allowlist bounded to named public files is proposed in the fix report and not built.
- **Cross-tab**: a change of who is signed in is tested with two real tabs. A tab of an earlier release learns it by its next request; no broadcast of a new build is tested.
- **A guard's refusal of a document request** keeps the application's own error page, not a PSX error document.
- **`psx:verify`** checks dependencies by reading constructors, to any depth, with nothing made; a service whose constructor throws is found at the first request.
- **In-page login** (`#[Action(auth: true)]`) is tested end to end in a browser by the acceptance application, with a real `AuthState`. The demo logs in with an ordinary form post.
- **Deployment**: a reload, a rollback, a tab of an earlier release and a request under way across a reload are tested against a local server in the background, browser- and server-rendered. Nothing was run behind a real proxy or on a real deployment. A release's id does not cover the application's own `src/`, its configuration, or package PHP that leaves the compiled pages the same.
- **Uploads**: size, type, conflict, cut-off bodies, an abandoned upload and what is left in the temporary folder are tested. There is no progress reporting.
- **Measurements** against an ordinary Crab route are in the report: one machine, minutes long, eight connections. Nothing longer or larger was run.
- **Remote development**: Vite's default CORS allows `localhost` origins only. An application served under another name in development must configure `server.cors` and `server.origin` itself.
- **Content Security Policy**: a nonce read from the request attribute `csp_nonce` is written on the document's module scripts and, in server markup, on React's own inline script. Tested under a strict policy. `style` props in server markup are inline styles, which `style-src 'self'` refuses; `php cua dev` cannot run under a strict policy.
- **Fixture logs**: the PHP test fixture prints its error log to stderr during the suite.

## Acceptance gates of design section 26

| Gate | Proof |
| --- | --- |
| Splitting survives PHP strings and TSX generics | P |
| Local names do not collide | P |
| Invalid schemas and name conflicts fail with locations | P |
| Server source never public | P, B: every address, the published tree, source maps, Vite's boundary and its overlay |
| Editor and CLI see the same types | CLI only; no editor |
| Guard chains for document, navigation, query, action | P |
| Layouts in order; failures omit later payloads | P |
| Layout state survives navigation | J, B, with a remount across tenants |
| Two instances of a reusable component | P, B |
| Query states, stale answers, eviction | J |
| Auth change discards old data | J, B with one and two tabs |
| Anchors, history, scroll, focus, blocking | J, B |
| Navigation A cannot commit after B | J, B |
| Save A cannot reset or redirect B | J, B |
| `useActionState`, drafts kept | B |
| Enter, submitter values, repeated lists, nullable fields, files | P, B |
| Overlapping edits conflict atomically | P, B |
| Deliberate behaviour for each status | 400, 401, 403, 404, 405, 406, 409, 413, 415, 422, 500, 503: P, B. 429 of the application's own: not tested; a proxy's 429: B |
| Forged ids, wrong scopes, stale builds never enter | P |
| Origin protection for login and mutations | B, and the framework's tests |
| Proxy errors and login redirects are not success | J, B through a test proxy |
| Interleaved users cannot leak state | B: two people overlapping in one worker, and forty requests at once |
| Lost answers stay unknown, no retries | J, B. The browser's own transport may send again; see the gaps |
| Escaping, unsafe URLs, prototype keys, unsafe integers | P, J |
| One dev command; add, edit, delete without loops | B |
| Failed build keeps the last good one | B, built and under `dev` |
| Old tabs, rolling reload, rollback | B, against a local server in the background |
| SSR isolated, bounded, hydration-stable | P, J, B |
| Upload limits and interrupted uploads | P, B |
| Coexistence with ordinary routes and custom errors | Ordinary routes: P, B. A custom error renderer and Arc pages: not tested |
| Performance and memory budgets | Measured once, on one machine; see the report |
