# Production-readiness report

2026-11-15. PSX 0.1.0, unreleased. Written at the end of the readiness pass that followed the round 1 to 4 reviews.

**Verdict: not production-ready.** The gates marked Pass below have repeatable tests, and those pass. Three design gates are still untested (Arc pages and a custom error renderer beside PSX, and a rate limit of the application's own), and one operational defect found at the end of the pass is open (a renderer left running by a server that was killed). What is still open is listed under [Open before a production release](#open-before-a-production-release): no separate reviewer has gone over the whole batch, no versioned artifact of what was tested is pinned, and the only environment tested is one Linux machine with Chromium. This is not an approval for production. Nothing here promises the absence of vulnerabilities; it records what was tested and what was not.

## What was run

| Suite | Command | Result |
| --- | --- | --- |
| PSX, PHP | `composer test` | 179 tests, 1238 assertions, pass |
| PSX, PHP style | `composer format:check`, `composer lint` | clean |
| PSX, TypeScript | `npm test` in `js/` | 261 tests, pass |
| PSX, TypeScript style | `npm run typecheck`, `npm run format:check`, `npm run build` | clean |
| Acceptance, built, rendered in the browser | `node run.mjs --mode=all` in `tests/acceptance/` | 65 tests: 52 pass, 13 skipped, 0 fail |
| Acceptance, built, rendered by the server | same run | 65 tests: 60 pass, 5 skipped, 0 fail |
| Acceptance, `php cua dev` | same run | 65 tests: 48 pass, 17 skipped, 0 fail |
| Demo, PHP | `composer test` in `psx-demo/` | 6 tests, 88 assertions, pass |
| Demo, Chromium, on a separate copy | `node --test tests/browser/demo.test.mjs` | built, browser-rendered: 13 pass, 1 skipped; built, server-rendered: 14 pass; `dev`: 13 pass, 1 skipped |
| Framework | not rerun | Its source is byte-identical to the accepted baseline (`git diff` and `git status` compared); the last run, 2412 tests, stands |

A skipped acceptance test is one that belongs to another mode and says so: the eight renderer tests outside `ssr`, the four edit tests outside `dev`, one Vite test outside `dev`, and under `dev` the six release tests and three tests of the policy and the published files, which `dev` does not have. None is skipped for failing.

The acceptance run was one invocation with the final code, installed from the packed packages. The packages were packed anew, on a new work folder, for the run before it (63 of these tests and the first of the two added last, no failure); this run added the outage test and used that same pack, no packed file having changed since. Its log was kept at `/tmp/psx-acceptance-final-run3.log` on the machine it ran on, the earlier one at `/tmp/psx-acceptance-final-run2.log`.

The coordinator ran the PHP and TypeScript suites, both format checks, the lint and the type check independently on the same source after the last production change: 179 tests and 1238 assertions, 261 tests, all clean, with the source and the built `dist` byte-identical before and after.

### Versions and machine

PHP 8.4.27 (NTS), Composer 2.10.1, Node 24.17.0, npm 11.13.0, React 19.2, TypeScript 7.0, Vite 8.3.8, Vitest 5.1.0, PHPUnit 13.4.7, Playwright 1.65.1 with its Chromium. Fedora Linux, kernel 7.0.12, x86_64, Intel Core i5-9400F (6 cores), 15 GB of memory. No other operating system and no other browser was used.

### How the acceptance application is set up

`tests/acceptance/app/` is a real application: cookie authentication from the framework with an `AuthState` of its own, SQLite, two layouts, pages for forms, uploads, long content, failures and a browser-only component, a reusable component with its own query and action, ordinary Crab routes beside the pages, and a strict Content-Security-Policy middleware. `Acceptance\Gate` holds a request at a named point until a test lets it go, so an overlap is made to happen.

The harness packs `crabphp/psx` with `composer archive`, `@crabphp/psx` with `npm pack`, and the framework from its checkout, and installs the application from those files only. Each test file gets its own copy, its own database and its own port from 8110 up, bound to 127.0.0.1. Nothing outside the work folder is written, started or stopped. See [tests/acceptance/README.md](../../tests/acceptance/README.md).

## Gates

"B" is a real Chromium test in `tests/acceptance/`, "J" Vitest in `js/test/`, "P" PHPUnit in `tests/`. Modes are those the test runs in.

| Gate | Result | Evidence |
| --- | --- | --- |
| Sign in, over and out in one tab; nothing of the earlier person stays (title, markup, bootstrap, caches) | Pass | B `auth.test.mjs` (csr, ssr, dev); J `races.test.ts` |
| A second tab hears of the change, drops what it held, reads again, sends nothing | Pass | B `auth.test.mjs` |
| Two tabs sign in at once: the later is refused by the revision, no cookie of it kept | Pass | B `auth.test.mjs`; P |
| A late answer asked as the earlier person is shown to nobody; no write is sent during the change or replayed after | Pass | B `auth.test.mjs` |
| A credential of an earlier revision is refused before anything is entered | Pass | B `auth.test.mjs`; P |
| First page's code still loading while who is signed in changes (READY-C01, C02) | Pass | B `auth.test.mjs`; J "READY-C01", "READY-C02" |
| Two people in one worker, overlapping documents, navigations, queries and saves stay their own | Pass | B `isolation.test.mjs`: 16 documents and 24 protocol navigations at once, answers in reverse order, the store checked |
| Layout state kept; a tenant's layout starts again for another tenant; two instances of one component | Pass | B `layout.test.mjs` |
| Links, history, scroll, focus, announcement, hash, blockers, overtaken navigation | Pass | B `navigation.test.mjs` |
| Loader refusal, loader exception, render exception: own page each, nothing of the source shown | Pass | B `navigation.test.mjs` |
| `clientOnly()` | Pass | B `navigation.test.mjs` |
| Enter, submitter, lists, empty and absent fields; drafts kept on refusal; ambiguous forms refused | Pass | B `forms.test.mjs` |
| Uploads: kept once, limits, cut-off bodies, an abandoned upload, nothing left in the temporary folder | Pass | B `requests.test.mjs` |
| Statuses 400, 404, 405, 406, 409, 413, 415, 422 | Pass | B `requests.test.mjs`; 401, 403 in `auth.test.mjs` and P; 500 in `navigation.test.mjs`; 503 in `ssr.test.mjs` |
| A proxy's error page, a page saying all is well, foreign JSON, redirects, 429, a cut-off answer: never success, the write sent once | Pass | B `proxy.test.mjs`, through a test proxy |
| A connection that dies before any answer | Pass for what PSX does (one send, unknown outcome); the browser's own transport re-sent the write, see limits | B `proxy.test.mjs` |
| Content-Security-Policy enforced with a nonce; nonce unique per document; no violation on any page | Pass | B `served.test.mjs` (csr, ssr) |
| No file of the server's is served, by any address; the published tree holds no PHP, source map or local path | Pass | B `served.test.mjs`; Vite's boundary under `dev` |
| Two releases, reload, a request under way across it | Pass | B `release.test.mjs` (csr, ssr) |
| A tab of the earlier release: write refused before entry, sent once, draft kept; its scripts still served; navigation becomes one new document | Pass | B `release.test.mjs` |
| Rollback by selecting the earlier release and reloading | Pass | B `release.test.mjs` |
| A failed build selects nothing and publishes nothing | Pass | B `release.test.mjs`, six ways to fail: TypeScript that does not check, PHP that does not parse, a declared page whose file is absent, a script importing a file of the server's, a script importing what does not exist, a loader with no declared return |
| The release id changes with page PHP, scripts, the bundled runtime and compiler output | Pass | B `release.test.mjs`; what it does not cover is under limits |
| No release, or one of another protocol: the server does not start | Pass | B `release.test.mjs` |
| One `dev` command: edit TSX, edit PHP, add a page, three edits that cannot be built, recovery, delete; no loops | Pass | B `dev.test.mjs` |
| Renderer socket: owner only, outside the public folder, of the served release, not answered over HTTP | Pass | B `ssr.test.mjs`; P `ToolingTest` |
| Hydration takes the server's markup over without complaint, also with a navigation begun before start (READY-C03) | Pass | B `ssr.test.mjs`; J "READY-C03" |
| Renderer bounds: past `max_inflight` a document is 503 with `Retry-After`, never another person's page | Pass | B `ssr.test.mjs`; J |
| Renderer killed: 503 while gone, restarted, never rendered another way | Pass | B `ssr.test.mjs` |
| Server readiness includes the renderer; reload of the same release; a document under way across the reload | Pass after three fixes | B `ssr.test.mjs`; P `ToolingTest`; J |
| A server whose renderer never listens, or listens after a worker gave up waiting: start and reload fail or wait, the old server is kept, no document is refused | Pass after fix 14 | `ssr.test.mjs` in the acceptance suite, the real server asked over HTTP; P `ToolingTest` with real workers |
| Connecting to the renderer: a quarter of a second for the whole exchange against a slow, silent or wrong answer, and no other request of the worker held up | Pass after fix 15 | P `ToolingTest`, inside the event loop |
| A renderer the server does not run is asked for pages only, and stops when told; a worker lets go of its own when it stops | Pass after fix 16 | P `ToolingTest` |
| A renderer that stays down: pages 503, the rest answered; a lost worker is not replaced and the server stops; recovery with the server running and after it stopped | Pass, and a deployment constraint | `ssr.test.mjs` in the acceptance suite, the real server asked over HTTP |
| Query cache: entry and byte bounds, garbage collection, released readers, late answers | Pass after one fix | J "READY-C04" |
| Read-ahead pages: bound of twenty, time to live, dropped on a write and on a change of who is signed in | Pass after two fixes | J "READY-C04" |
| Packaging: the application installs and builds from the packed packages alone | Pass | every acceptance run starts with it |
| Performance and memory against ordinary Crab routes | Measured, below | `tests/acceptance/measure.mjs` |
| Coexistence with ordinary routes | Pass | B `navigation.test.mjs`; P |
| Coexistence with ordinary Crab routes | Pass | P `ContractTest`; B `navigation.test.mjs` |
| Coexistence with Arc pages and a custom error renderer | Not tested | Started at the end of the pass and stopped before any test was written |
| 429 from a rate limit of the application's own, as a PSX problem | Not tested, on the server or in the browser | Only a proxy's 429 is: B `proxy.test.mjs`. An earlier STATUS said the server side was tested; it was not |
| Editor and CLI see the same types | Not applicable: no editor tooling exists | |

## Defects found and fixed in this pass

Each has a regression that fails without the fix.

| | Defect | Fix |
| --- | --- | --- |
| 1 | The title and head tags of the earlier person stayed during a change of who is signed in | The head is cleared when the page is |
| 2 | The bootstrap JSON of the document stayed in the DOM for its lifetime | Removed once read. What the network or the browser's history already received is not erased by this |
| 3 | A hash link reloaded the document; a document opened at a hash did not scroll to it | The router adopts the browser's own fragment step |
| 4 | Under a nonce policy, React's inline form-replay script in server markup had no nonce | The renderer is told the nonce and puts it on that exact script only |
| 5 | READY-C01: a document's own page, arriving late, overwrote a newer navigation and set back what was known of who is signed in | The document's page is shown only where nothing took its place; identity is taken from the document at once and never set back |
| 6 | READY-C02: the application was not mounted until the document's own code arrived, however late | Mounted once, at whichever comes first: the document's page, a newer page, or the wait while identity is settled |
| 7 | READY-C03: a navigation begun before start made React report a hydration mismatch | The server's snapshot is kept for hydration; the navigation's state is shown after, as an update |
| 8 | After a reload, a server-rendered document was 503 until the new renderer listened | A worker starts once its renderer listens. One that waited five seconds does not start, so a server whose renderer does not come is never ready and never takes the place of one that works |
| 9 | Two server processes of one release shared a renderer socket path; one stopping could remove the other's | The socket is named for the server process too; sockets of killed processes are removed at the next start |
| 10 | A retiring server stopped its renderer at once, so a document under way in it was 503 | Each worker stays connected to its renderer; the renderer serves until the last has stopped |
| 11 | A page read ahead was shown after a write that changed it | Everything read ahead is dropped when a write was sent |
| 12 | A read-ahead that failed late removed a newer one for the same address | It removes only itself |
| 13 | The timer of a cache entry that was evicted could remove a newer entry of the same query | It removes only itself; eviction cancels the timer |
| 14 | Found in review of fix 8: a worker that had waited five seconds started without its renderer, so an unready server was announced ready | It fails to start instead; start and reload fail, the old server stays (see 8) |
| 15 | Found in review of fix 10: connecting to the renderer had a limit for each read and none for the whole, and blocked the worker: a slow answer held a render for 0.8 s against a limit of 0.1 s | One limit for the whole exchange, 0.25 s or the page's own if smaller, on the same non-blocking wait as a render; the answer must be one whole message; one attempt at a time |
| 16 | Found in review of fix 10: any `SocketRenderer` connected itself on its first render, so a renderer run by somebody else was kept from stopping | Only a worker of a server that runs the renderer asks for the connection, and lets go of it when it stops |

Changed production files: `js/src/router.ts`, `start.ts`, `view.tsx`, `queries.ts`, `runtime.ts`, `socket.ts`, `ssr.ts`, `vite.ts`, `testing.ts`; `src/PsxPlugin.php`, `src/Runtime/Kernel.php`, `PsxDefinition.php`, `SocketRenderer.php`, `PageHandler.php`, `src/Contracts/RendererTransport.php`. The framework was not changed.

**One signature changed.** `RendererTransport::render(array $envelope, ?string $nonce = null): string`. An application that binds its own implementation must add the parameter; PHP refuses an implementation without it.

## Measurements

`node measure.mjs` in `tests/acceptance/`: the page `/long` (two hundred lines of data) against an ordinary Crab route returning the same data as JSON. Two workers, `opcache.jit=disable`, 3000 requests a route, 8 at a time, the best of three rounds after a warm-up of the same size. The client is one Node process on the same machine, and is itself what limits the fastest rows.

| Built, `psx.rendering = client` | req/s | p50 ms | p95 ms | p99 ms | bytes |
| --- | --- | --- | --- | --- | --- |
| Ordinary route, JSON | 4948 | 1.31 | 2.62 | 5.21 | 3712 |
| Page, navigation | 5636 | 1.42 | 1.93 | 2.50 | 4114 |
| Page, document | 5466 | 1.37 | 2.46 | 3.00 | 4796 |

| Built, `psx.rendering = server` | req/s | p50 ms | p95 ms | p99 ms | bytes |
| --- | --- | --- | --- | --- | --- |
| Ordinary route, JSON | 5010 | 1.28 | 2.55 | 4.32 | 3712 |
| Page, navigation | 5136 | 1.33 | 2.65 | 2.93 | 4114 |
| Page, document | 694 | 9.75 | 31.34 | 35.14 | 12744 |

- A navigation and a browser-rendered document cost the same as the ordinary route within what this client can tell apart: the differences between rounds are larger than between rows, so a row above another is not evidence that one is faster.
- A server-rendered document is about a seventh of that: the one Node renderer of the server process is the limit.
- **Memory.** The two PHP workers held 51.4 MB warm and 51.5 MB after 36 000 requests. With server rendering, the three PHP processes held 74.6 MB warm and 75.4 MB after; the renderer 59.5 MB at start, 186.3 MB warm and 187.1 MB after, under its heap limit of 256 MB.
- **Scripts.** The entry with React and the runtime is 276 574 bytes, 85 254 gzipped; the page's own module 1783 bytes.

Measured by the tests on the way: of 60 documents asked at once of one worker, 16 were rendered and 44 answered 503 with `Retry-After`; a killed renderer answered again after about 2.5 seconds, with about 70 documents answered 503 meanwhile; across three reloads of one release, every one of 90 documents was rendered, the one under way included. A reload to a renderer that never listens failed after 21 seconds with all 364 documents asked meanwhile rendered by the old server; one to a renderer that listens after 8 seconds was done after 8.4 seconds, all 529 rendered. With the renderer down and a worker lost, the server had stopped after 50 seconds; put right while the server still ran, pages were rendered again after 2.6 seconds.

These are one machine's numbers under a small load, over the loopback interface, the best round of three. They compare routes on one setup; they are not what a production server will carry, and they do not show PSX to be faster than an ordinary route. No test ran for hours, and none used more than a few dozen connections.

## Supported limits

| | Limit |
| --- | --- |
| Writes | Sent once by PSX, never retried. The browser's own transport re-sent a `POST` whose reused connection died before any byte of the answer: twice in this run, three times in an earlier one. A proxy may do the same. Exactly-once needs an idempotency key in the application's own input and store |
| Unknown outcomes | A lost answer, a proxy's page, a body over the engine's limit (413 from the engine is not a PSX answer) are reported as unknown or protocol failures; the page never treats them as done or not done |
| Strict input | Ambiguous input is 400, input that does not fit is 422; a field the input does not declare is ignored |
| Server rendering | 16 pages at once for each worker, then 503 with `Retry-After: 1`; one renderer for each server process; a render that never settles holds its place until the renderer restarts; about 2.4 s of 503 after a renderer crash. A server is not ready before its renderer listens: start and reload fail after 20 s without it. **A renderer that stays down can stop the whole server**: a worker that has to be started meanwhile cannot start, and six failed starts in a minute stop the server under the framework's rule, routes that render nothing included (about 50 s after a worker was lost, in the test). Recovery is in the README and is tested both ways: with the server still running, and after it stopped. Browser rendering is not affected |
| Reload | Needs `php cua start --daemon`. `reload` fails, and the old server keeps serving, when the application cannot be defined |
| Release id | Covers page PHP as compiled, scripts, the bundled runtime, compiler output and the protocol. Not the application's `src/`, its configuration, or package PHP that leaves compiled pages the same |
| Build checks | PHP is not type-checked at build: a loader that returns the wrong type fails at the request. TypeScript, declared shapes and dependencies are checked |
| Assets | Kept for every release and never removed by a build; pruning is the application's |
| Query cache | 200 entries, 8 MiB, 300 s after the last reader; entries that are read are never evicted, so a page that reads more than the bound holds more than the bound while it does |
| Read ahead | 20 pages, 15 s, dropped on any write and on a change of who is signed in |
| Policy | `style` props in server markup are inline styles, refused by `style-src 'self'`; an answer written outside the application's middleware carries no policy; `php cua dev` cannot run under a strict policy |
| Development | Anyone who can reach the Vite port can make its error overlay appear on open pages (no source is shown); it is a development server |
| Erasure | Removing the bootstrap and clearing the page does not erase what the network, a proxy or the browser's history already holds |
| Old sockets | A renderer socket left by a version before this pass has no process number in its name and is not removed |
| A server killed outright | Its renderer stops within about a second (fixed after 0.1.0, see below); a server that was stopped is not affected |
| Platform | Linux, Chromium. macOS is expected to work and was not run. Windows is unsupported |

## Open before a production release

1. **No separate reviewer has gone over the whole batch.** The coordinator reviewed the renderer lifecycle and the cache changes, found the readiness and connection defects (14 to 16) and rechecked their fixes with its own counterexamples, reran READY-C01 to C03 independently, and ran the complete PHP and TypeScript suites on the final source. What has not happened is a fresh review of all of this pass's production changes by a reviewer who did not take part in it.
2. **Fixed after 0.1.0 (2026-11-18), recorded here as it was found: a renderer can outlive its server.** The supervised renderer now watches the process that started it and stops when it is gone, and a renderer whose path was taken leaves the other's socket; see [STATUS](../STATUS.md). Process 297381 was ended on 2026-11-18. As found: When every PHP process of a server is killed outright (`SIGKILL`), or only the worker that runs the renderer is, the Node renderer is not told and keeps running, 60 to 190 MB, until someone ends it; in the second case the server also starts another, and the workers stay connected to the old one. Stopping the server, or killing only its main process, is clean. Reproduced on a separate copy of the demo (`/tmp/psx-orphan2.sh`); not fixed in this pass. It predates the pass: renderers left this way by earlier runs were found on the machine. One is still there and was deliberately not touched: process 297381, started 2026-11-15 07:46, working folder `psx-demo`, release `50f7024fa536abaa`, parent gone, listening at `storage/psx/ssr-50f7024fa536abaa.sock`. It is not part of the preview that runs now. Until this is fixed, look for `ssr/server.mjs` processes after a server was killed.
3. **Two design gates are untested**: Arc pages and a custom error renderer beside PSX, and a 429 from the application's own rate limit, on the server and in the browser.
4. **No pinned artifact of what was tested.** The packages are installed from path repositories and development dependencies float. A deployment needs a versioned, pinned build of both packages, the one that was tested, and lock files in the application that consumes them. Publishing is not required for that and was not authorized; a library does not have to ship a lock file of its own.
5. **One environment.** One machine, one operating system, one browser engine. Firefox and WebKit were not run.
6. **No real proxy or deployment.** Proxy behaviour is tested through a test proxy. No run went through Caddy or nginx, TLS, or a deployment with real traffic; the system's proxy and firewall were deliberately left alone.
7. **No long or large run.** Measurements are minutes long at eight connections. Memory growth over hours and behaviour under hundreds of connections are unknown.
8. **With server rendering, a renderer that stays down can stop the whole server.** Deliberate, tested and documented in the README with its recovery; a deployment has to plan for it.
9. **Separate capability gaps**, not part of this pass: editor tooling, Windows.

The earlier known gaps that this pass did not change are still in [STATUS.md](../STATUS.md).

## The preview

The demo at `http://127.0.0.1:8094` was restarted on the final code of this pass.

- Build `a8e7f66a2ea92210`, browser-rendered as its settings say; the last changes were PHP of the package, which a release's id does not cover, so the id is the same as before. The previous release `7ff5200a9554f225` is kept, and its scripts are still served.
- It runs in the `hc` terminal named `psx-demo`, with the same command as before.
- Before anything was changed, the database (SQLite's own backup, integrity checked), the uploaded covers and the settings file were copied to `~/.local/share/psx-demo-backups/20261115T191502`, readable by the owner only. The backups of the two earlier restarts are beside it.
- The final code was first checked, built and run through the demo's Chromium tests on a separate copy with its own database, in all three modes: 13 pass and 1 skipped, 14 pass, 13 pass and 1 skipped.
- After the restart: 80 posts, 1 user, 9 covers, as before; the settings file byte-identical. The checks on the live preview were read-only: the login page and its script answered, the earlier release's script was still served, a visitor was sent to the login, a request naming another release was refused with 409, and no source or settings file was served. Nobody was signed in and nothing was written.
