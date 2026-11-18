# Acceptance tests

These run a real application in real Chromium, against the packages as they would be installed: the Composer archive of `crabphp/psx`, the npm tarball of `@crabphp/psx`, and the framework from its checkout. They are the proof behind the gates in [the production-readiness report](../../docs/reports/production-readiness.md).

## Run them

```sh
cd tests/acceptance
npm install                      # Playwright, once; `npx playwright install chromium` if it has no browser
node run.mjs --mode=all          # every file: csr, then ssr, then dev
node run.mjs --mode=ssr auth     # the files whose name has "auth", server-rendered
ACCEPTANCE_WORK=/tmp/x node run.mjs   # keep what it makes in a folder you name
```

One file, without the runner (the packages are installed on first use):

```sh
ACCEPTANCE_MODE=ssr ACCEPTANCE_WORK=/tmp/x node --test --test-concurrency=1 release.test.mjs
```

The measurements are separate, and take a quiet machine:

```sh
ACCEPTANCE_WORK=/tmp/x node measure.mjs
```

It needs PHP 8.4, Node 24, Composer and npm on the `PATH`. A full run takes about a quarter of an hour.

## The three modes

| Mode | What is served |
| --- | --- |
| `csr` | A release built by `php cua psx:build`, served by `php cua start`, rendered in the browser |
| `ssr` | The same, with `psx.rendering` set to `server`: the supervised Node renderer writes the first markup |
| `dev` | `php cua dev`: the pages compiled as they change, with Vite beside the server |

A file that only makes sense in one mode skips itself in the others and says why: `release.test.mjs` needs a built release, `ssr.test.mjs` a renderer, `dev.test.mjs` the dev command.

## What is where

- `app/` is the application: its pages (`resources/`), routes, middleware and settings. It signs people in with the framework's cookie authentication and an `AuthState` of its own (`src/`), keeps its data in SQLite, and holds a request at a named point when a test asks (`Acceptance\Gate`), so that an overlap is made to happen and not hoped for.
- `lib/harness.mjs` packs and installs the packages once per work folder, again when their source changed, and copies the application for each test file. It starts and stops only servers it started, each on a port of its own from 8110 up, bound to 127.0.0.1.
- `lib/target.mjs` builds and serves an application in the mode asked for, and has what the tests share: `open`, `signIn`, `alive`, `shown`.
- `*.test.mjs` are the tests, one file for one concern. `run.mjs` runs them in order, one at a time.

## What it touches

Everything is made under `ACCEPTANCE_WORK`, or a new folder under the system's temporary one. Nothing is written into a checkout, no database but each copy's own SQLite file is opened, and nothing outside that folder is started, stopped or deleted. Nothing listens beyond the machine.

## Reading a result

A test fails when a page reports anything through `onError`, or throws: the application's entry sends both to the console and `open()` collects them. Lines marked `ℹ` are measurements a test took on the way, such as how many documents a busy renderer refused; they are recorded in the report and are not pass or fail.
