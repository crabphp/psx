# Implementation report

2026-11-15. Built from `brainstorm/psx/IMPLEMENTATION-HANDOFF.md` and the reviewed design, [DESIGN.md](DESIGN.md). [STATUS.md](STATUS.md) holds the feature matrix, the deviations and the gaps in full; this report says what exists, how it was checked and what remains.

Nothing was committed, pushed, published or deployed.

## Preview

**<http://127.0.0.1:8094>**, log in as `demo@example.test` / `crab-demo`.

It is `php cua dev` in `psx-demo/`, running in the hc terminal `psx-demo`. Vite is on `http://localhost:5173` beside it. The terminal was started to outlive the session that made it; `hc kill psx-demo` stops it.

## What was built

### `psx/`: the Composer package `crabphp/psx`

56 PHP files in `src/`, about 8,000 lines.

| Folder | |
| --- | --- |
| `src/` | The public PHP API: `PsxPlugin`, `#[Query]`, `#[Action]`, `PageData`, `QueryData`, `ActionResult`, `Failure`, `Redirect`, `Head`, `Tags`, `MapOf`, `AuthSnapshot` |
| `src/Contracts/` | `Pages` and the declaration interfaces, `AuthState`, `RendererTransport`, `DocumentRenderer` |
| `src/Compiler/` | Splitting a `.psx` file, reading the `Server` class, shapes, route families and operation ids, TypeScript generation |
| `src/Registry/` | The explicit page, layout and service declarations |
| `src/Runtime/` | Protocol, wire codec, responder, page and operation handlers, document and assets, the definition that adds the routes, the socket renderer, the `dev` steps |
| `src/Commands/` | `psx:init`, `psx:check`, `psx:build`, `psx:list`, `psx:types`, and the internal `psx:compile`, `psx:verify` |
| `src/Testing/` | `PsxTest`, `PsxResponse` |
| `tests/` | `CompilerTest` (46), `RuntimeTest` (26), `ToolingTest` (6), a fixture application |
| `docs/` | This report, `STATUS.md`, and the design with its reviews, copied unchanged |

### `psx/js/`: the npm package `@crabphp/psx`

16 source files, about 4,300 lines: the runtime (`runtime`, `router`, `queries`, `protocol`, `shapes`, `view`, `start`), bindings, the Vite plugin (`vite`), server rendering (`ssr`, `socket`) and test helpers (`testing`). Tests in `js/test/`: 50.

### `psx-demo/`: the demo application

48 files. SQLite posts admin with login, list and search, create, edit with version conflict, cover upload, a layout and a query-backed component. See its `README.md`.

### `framework/`: integration contracts

The contracts of design section 25, added earlier in this work, are documented now:

- New: `Contracts\Definition`, `Definitions`, `Development`, `Invocation`; `Contracts\Routing\Actions`, `PreparedAction`, `ActionOutcome`, `InputProjection`; `Contracts\Http\Representation`, `Representations`, `Errors`, `DecodePolicy`, `DecodePolicies`, `Decoding`; `Http\SameOrigin`, `Http\StrictDecoder`, `Http\SelectDecoding` and the implementations.
- Changed: `App`, `AppBuilder`, `Cua`, `Server`, `ProgramWorker`, `Routing\Router`, `Routing\ActionHandler`, `Http\Request`, `Http\Multipart`, `Http\ErrorResponse`, `Http\RenderedErrors`, `Contracts\Http\Problem`, `Auth\CookieAuth`, `Commands\Describe`, `Commands\DescribeText`.
- Tests: `tests/Routing/PreparedActionTest.php`, `tests/Http/StrictDecoderTest.php`, `tests/Http/SameOriginTest.php`, `tests/Integration/`, and additions to `CookieAuthTest` and `DescribeTest`.
- Documents, this session: `CHANGELOG.md` (Unreleased), `docs/plugins.md` (a new section), `docs/authentication.md`, `ARCHITECTURE.md` (extension points).

**One behaviour change for existing applications:** `CookieAuth` with a `login` address redirects a refused `GET` only when the request takes a page. A request that asks for JSON alone gets `401` with the address in its problem. The changelog says what to change.

## Commands and results

All run on 2026-11-15 with PHP 8.4.27, Node 24.17, TypeScript 7.0.2, Vite 8.3.8.

| Where | Command | Result |
| --- | --- | --- |
| `framework/` | `composer test` | 2407 tests, 40324 assertions, 44 skipped |
| `framework/` | `composer format:check`, `composer lint` | Formatted; 3 lint hints in `src/Engine/Process/`, which this work did not touch |
| `psx/` | `composer test` | 78 tests, 498 assertions |
| `psx/` | `composer format:check`, `composer lint` | Clean |
| `psx/js/` | `npm test` | 50 tests in 3 files |
| `psx/js/` | `npm run typecheck`, `npm run format:check`, `npm run build` | Clean |
| `psx-demo/` | `composer test` | 5 tests, 70 assertions |
| `psx-demo/` | `php cua psx:check` | Compiled, defined, typechecked |
| `psx-demo/` | `php cua psx:build` | Release built and selected; its scripts and styles published to `public/assets/psx/` |
| `psx-demo/` | Browser suite against `php cua dev` | 11 pass, 1 skipped (the hydration test, which needs server rendering) |
| `psx-demo/` | Browser suite against `php cua start` on the built release | 11 pass, 1 skipped |
| `psx-demo/` | `PSX_RENDERING=server php cua psx:build`, then `start`; browser suite | 12 pass. The renderer ran as the supervised process `psx-ssr` on a socket of mode 0600 |

### From a clean state

A copy of the demo without `vendor/`, `node_modules/`, `.psx/`, `build/`, `storage/` contents, `.env` or lock files was made in `/tmp/psx-demo-clean`. There: `composer install`, `npm install`, `cp .env.example .env`, `php cua migrate`, `php cua demo:seed`, `php cua psx:check`, `php cua psx:build`, `php cua start`. The browser suite passed 11 of 11 against it. The SQLite file then held the posts the tests made, with their versions and the cover's file name, and the cover was on disk. The same copy under `php cua dev` passed 11 of 11, with Vite on the next free port.

The build id of the clean copy equalled that of the working demo: the same sources give the same release.

### Development lifecycle, scripted in Chromium

| Edit | Observed |
| --- | --- |
| TSX of a page | Updated in place; a marker on `window` and a typed password survived |
| PHP of a page | "Restarted" in the terminal; the page loaded again with the new title |
| PHP that does not compile | The terminal named the file and line; the server kept answering 200 with the last good page |
| Restored | Served again |

### Source separation, checked by hand

- The Vite dev server answers 403 for `/resources/pages/Home.psx`, with `?raw`, and through `/@fs/`.
- `import x from './PostFinder.psx?raw'` stops the build in Vite with a message; TypeScript refuses it first.
- `import { $findPosts } from './PostFinder.psx?server'` typechecks and builds.
- The production server answers 404 for `/resources/...psx`, `/build/psx/current/manifest.json`, `/.psx/manifest.ts` and `/.env`.
- A build that failed left the previous release selected.

## Defects found and fixed while verifying

Each was found by running the real thing, not by reading.

1. **TypeScript checked nothing.** `"include": [".psx"]` is skipped because the folder starts with a dot; only `entry.tsx` was checked, and a wrong route builder reached the browser. `psx:init` now writes `.psx/**/*.ts` and `.psx/**/*.tsx`.
2. **Empty objects became lists in documents.** The bootstrap was decoded to PHP arrays and encoded again, turning `{}` into `[]`, which the client rightly refused. It is now kept as objects; a test holds it.
3. **The public folder was read from `app.public`**, which does not exist; it is `server.public`.
4. **`psx:init` could not run** in an application whose pages file was missing or named a missing file. It no longer loads declarations.
5. **A start failure was silent** in the browser. It is logged in development.
6. **The renderer's idle timeout cut renders short**: the socket's timer kept running while a page rendered. It stops once the request is read.
7. **A date shape accepted any string** on the client. It now requires the format the server writes.
8. **The renderer bundle used a deprecated Rolldown option.**

## Supported capabilities

In short; the matrix in [STATUS.md](STATUS.md) has each with its proof.

- The `.psx` format, typed `Server` modules, DTO projection to TypeScript, private and public artifacts kept apart.
- Explicit pages, layouts and services as ordinary Crab route families with their guard chains.
- Loaders, queries and actions; expected failures, redirects, tags and invalidation.
- The `psx/1` protocol with build and schema checks, strict input, and values checked against their declared shape on both sides.
- A client router with immutable scopes, blockers and a query cache; React forms with `useActionState`; uploads as forms.
- `php cua dev` as the one command; a coordinated production build; a server that refuses to start without a release.
- Optional server rendering through a supervised renderer on a private socket, and through Vite in development.
- Test helpers for PHP and TypeScript.

## Known gaps

The full list is in [STATUS.md](STATUS.md). The ones that matter most:

- **No editor extension.** Type errors name the generated file, not the `.psx`.
- **Not production-ready.** Several acceptance gates of design section 26 have no automated proof: rolling reloads and rollback, old tabs on a real deployment, interrupted uploads, concurrency between users, performance and memory budgets, source maps.
- **In-page login** is tested on each side but not end to end; the demo logs in with an ordinary form post, as the design recommends.
- **Parts of the client are implemented and untested**: cache eviction, scroll and focus restoration, hash navigation, prefetch, `clientOnly`, the cross-tab auth broadcast.
- **Windows is unsupported.**
- **Unreleased.** Versions and peer ranges are what was installed here, not a tested range.

## Risks

- The framework changes touch the router, the request and error rendering. The framework suite passes, and other applications in this folder were not run against the changed framework.
- The `CookieAuth` change alters what a script gets from a guarded address; an application that relied on the redirect needs the change the changelog describes.
- The toolchain is new (TypeScript 7, Vite 8 with Rolldown). The plugin sets `server.origin` after Vite starts listening, which Vite does not document.
- A release's scripts are kept beside older ones in `public/assets/psx/`; nothing prunes old releases or assets yet.

## Left in place

- The hc terminal `psx-demo`, serving the preview.
- `/tmp/psx-demo-clean`, the clean copy, and `/tmp/psxs`, an early scratch folder. Both are safe to delete.
- `psx-demo/build/psx/releases/` holds three releases from the client and server-rendered builds.
