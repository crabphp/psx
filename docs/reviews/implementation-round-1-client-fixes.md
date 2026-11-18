# PSX implementation review, round 1 — client fixes

2026-11-15. Answers [implementation-round-1-client.md](implementation-round-1-client.md), findings R1-C01 to R1-C07. Client only: `js/src/` and `js/test/`. Nothing in the compiler, the PHP runtime or the framework was changed, and nothing was committed. This batch does not complete the acceptance matrix; `docs/STATUS.md` has only its test counts updated.

## Changed files

| File | What changed |
| --- | --- |
| `js/src/router.ts` | Intents, origins, refresh order, the barrier, admission of answers by auth snapshot |
| `js/src/runtime.ts` | `writable()`, `standing()`, `witness()`, `doubt()`, `readAuth()`; checks on query and action answers |
| `js/src/queries.ts` | Enabled readers tracked apart from listeners; a request has an owner; a released request is detached |
| `js/src/types.ts` | `NavigationOrigin` gains `intent` |
| `js/test/races.test.ts` | New: 61 tests, every order of events set by deferred promises |
| `js/test/app.test.tsx` | One new test: `useQuery` under React StrictMode |

## Results

Run in `psx/js/` with Node 24.17. Exit codes were read without a pipe.

| Command | Result |
| --- | --- |
| `npm test` | 4 files, 112 tests pass (50 before this batch, 62 new), exit 0 |
| `npm run typecheck` | exit 0 |
| `npm run format:check` | exit 0 |
| `npm run build` | exit 0 |
| The new tests against the pre-fix source (`/tmp/psx-review-baseline-6gjmw6zu/psx/js/src`, copied to `/tmp/psx-c-baseline`) | 52 of the 62 new tests fail there; the other 10 state behaviour that was right and must stay; the 50 old tests pass |
| `php cua psx:check` in `psx-demo/` | Compiles and typechecks against the rebuilt client |
| Chromium suite of the demo, on a copy (`/tmp/psx-demo-clean`, port 8095) built with the fixed client | 13 pass, 1 skipped (server rendering), exit 0 |

The live demo on port 8094 was not rebuilt or restarted; it still serves the release built before this batch. The reviewer's repro (`/tmp/psx-r1-repros-GH7CnoFu/client.mjs`) asserts the broken behaviour and was left as it is.

## Findings

### R1-C01 — document navigation bypassed `ifCurrent` and blockers

**Invariant restored.** `navigate()` checks `ifCurrent` first, for every target. A target that is no page of this application (another origin, or an ordinary route of this site) then becomes an intent like any other: it is numbered, passes each blocker, and leaves the document only when nothing holds it. `proceed()` leaves; `reset()` and `dispose()` do not. A loader's redirect found by a refresh or by Back goes the same way, including one of mode `document`.

A new intent now also drops what a blocker held of an older one, so `proceed()` on it is `superseded` and its snapshot is null.

**Proof** (`races.test.ts`, "R1-C01"): stale origin to an ordinary and to an external target; a current origin held by a blocker for both, with reset and proceed; leaving at once when nothing blocks; a newer navigation replacing a held one; a `document` redirect from a refresh held by a blocker.

### R1-C02 — origins did not identify their navigation

**Invariant restored.** Every intent has a number, and an origin carries the number that was the latest when it was made (`NavigationOrigin.intent`). `current()` requires it to equal the router's. So an origin is left behind by a replacement in the same entry, by an attempt that is held, by one that failed, by Back and Forward to the same entry, and by a move to another place in the page.

When an attempt ends with the page still shown (reset, dispose, failure, a document navigation, a hash move) the page's nodes are given fresh frozen scopes with an origin of now. `commit` is unchanged, so scroll and focus are not touched. A refresh keeps the origin object it had. A navigation guarded by the page's current origin commits: its own number is compared at commit, not the one it was given.

**Proof** ("R1-C02"): replace then old origin; the page redirecting itself; origin kept through `revalidate()`; held then reset, with the fresh scope frozen and bindable; failure; Back and Forward; hash.

### R1-C03 — the barrier let writes through and let a stale reconciliation commit

**Invariant restored.** One question, `Runtime.writable()`, is asked before every write: false while an auth action is in flight and from the moment reconciliation starts until a page is shown as whoever is signed in. It stays false when reconciliation ends in `document-required`. A refused write is `RequestFailure` of kind `auth`, outcome `not-sent`; it is not kept and never sent later. The barrier is entered in the same turn as the auth action's answer, so no write fits between.

During the barrier the page in the router's state is null, not only hidden. A reconciliation installs only if the auth epoch, its own intent number and the address are all still its own. When a second change overtakes it, it installs nothing, clears nothing, and both callers get the newer one's result. It is bounded by its own timer, also against a transport that ignores cancellation.

Navigation during the barrier is **held**, not superseding: `navigate()` waits for the settling, then goes on normally, or by the document when the page could not be settled here. A step through history during the barrier loads the document at that address. A step that was already loading when the barrier began is taken as the place to settle at, because the address bar is already there.

**Proof** ("R1-C03"): held GET with an attempted POST, then the POST after settling; three ways to `document-required`, each still refusing; timeout with a transport that never answers; held navigation in both outcomes; an old origin during and after; two overlapping changes in both completion orders; an auth action with other writes refused meanwhile and its success kept when reconciliation fails; no gap after the answer; a lost answer to an auth action; Back in flight and Back during the barrier.

### R1-C04 — an older auth revision could reinstall the previous principal

**Invariant restored.** `Runtime.standing()` is the one comparison, used by every path that shows or caches an answer: navigation, Back and Forward, refresh, a page fetched ahead, reconciliation, queries and action results. Revisions are compared as numbers (`BigInt`), and a revision that is not decimal is no snapshot.

| The answer's snapshot, against what is known | What happens |
| --- | --- |
| Same context, revision and partition | Shown |
| Same context and partition, later revision | Known snapshot advanced, shown |
| Same context and partition, earlier revision | Dropped. A navigation fails with a retry; a query rejects. No barrier: it is the same person |
| Absent, another context, another partition, or not a number | Not shown. Everything held is dropped and the page is reconciled |
| Nothing was known yet | Taken as the first account, no barrier |

Reconciliation takes its fresh read unless it carries no snapshot while one was known, or is of the same context at an earlier revision; then it is `document-required`. A later revision seen in a dropped answer raises the floor reconciliation compares against. Nothing is asked twice on its own: one doubtful answer causes one reconciling read.

A query answer that arrives after who is signed in changed is now rejected for a direct caller too, instead of being returned.

**Proof** ("R1-C04"): the reviewer's case end to end; the browser still answering as before; same-person older; numeric order (`9` and `10`); five kinds of doubtful snapshot; another context; a settling read that says nothing; refresh, fetched-ahead and Back; queries; an action whose answer is doubtful; the first snapshot.

### R1-C05 — overlapping revalidations committed in completion order

**Invariant restored.** Each refresh takes a ticket. A success is shown only if its ticket is later than the last one shown. A failure or a redirect acts only if no later refresh was asked for. A refresh is bound to the page instance (`commit`) and the auth epoch, not to the intent number, so an attempt to leave that was held and given up does not undo it; a committed navigation does.

**Proof** ("R1-C05"): both completion orders; an overtaken failure and an overtaken redirect; the latest failing while an earlier one succeeds; two saves' refreshes out of order; a refresh surviving a held and reset attempt; a refresh dropped after navigation.

### R1-C06 — resubscription inherited an aborted request

**Invariant restored.** A request is released only when nobody wants it, and that is decided at the end of the turn (a microtask), so a reader that leaves and returns at once, as React's effects do, keeps it. A released request is cancelled and detached in one step: the entry is no longer fetching, and whatever the transport later says of the old request changes nothing. The next reader starts its own.

**Proof** ("R1-C06", and `app.test.tsx` under StrictMode): same-turn return; return while the transport is still settling the cancellation; an answer to a released request arriving after the new one started; one of two readers leaving; the last reader leaving, with the entry collected; StrictMode with one request and no cancellation.

### R1-C07 — invalidation fetched disabled queries

**Invariant restored.** The cache records for each reader whether it is enabled. Invalidation marks every matching entry stale and reads only where an enabled reader is present. `refetch()` is an explicit request and is kept to its end, including one more read when what it reads changed meanwhile. A request with only disabled readers left is released.

**Proof** ("R1-C07"): all disabled, by filterless, key and tag invalidation; stale data read again on enabling, inside its stale time; mixed readers; the enabled one leaving; `refetch()` by a disabled reader.

## Protocol dependencies and open questions

None of these blocked the batch. The first three need a decision on the server side.

1. **Problem and redirect envelopes carry no auth snapshot.** A loader failure is committed with the data of the layouts that ran before it, and the client cannot hold that to a revision; it is guarded by the local epoch alone. The client already reads `auth` on a problem envelope or its `pageError` if the server adds it.
2. **The client relies on every data envelope carrying a snapshot when the adapter is on**, which is what `Responder::data()` does today. With a snapshot known, an answer without one closes the page and reconciles. Any server path that omits it would do that on every request.
3. **A refused auth action** (`ok: false` from an `#[Action(auth: true)]`) does not reconcile, as before. Design section 17 step 4 says an ambiguous answer always does; whether a declared failure counts is not settled. Expected failures and thrown errors are read exactly as before this batch.
4. **`authChanged: true` without the adapter** still reconciles on the client, and with nothing known a reconciling read without a snapshot is accepted. This is the default integration the design describes; the server-side acceptance of an unmarked `authChanged` is the reviewer's separate finding.
5. **`NavigationOrigin` has a third field, `intent`.** Design section 9 shows two. An origin built by hand without it is never current.

Decisions made here that the re-review should confirm:

- Navigation during the barrier waits rather than supersedes; history traversal during the barrier loads the document.
- An older answer about the same person fails the read without a barrier.
- A document navigation ignores `replace`: `leave` takes an address only.

## Not covered

- The cross-tab broadcast is still untested.
- No real-browser test exercises the auth adapter; the demo logs in by a form post. The barrier and snapshot rules are proven in jsdom against the real `Runtime`, `RouterCore` and `QueryCache`.
- A step through history that a newer `navigate()` overtakes still leaves the history index as it was before this batch.

## Correction after the coordinator's re-review

`/home/daudau/Code/brainstorm/psx/CLIENT-REREVIEW-NOTES.md` found a regression this batch introduced: `Runtime.read()` rejected every query answer whose snapshot was not exactly `current`, so a later revision of the same person (`advanced`, which the table above says is taken) failed with a message about a change of who is signed in, though nothing was reconciled. The first snapshot seen on a query failed the same way.

**Fix.** `js/src/runtime.ts`: `read()` rejects only `stale` and `doubtful`. `advanced` is taken, and `witness()` has by then advanced the known snapshot.

**Proof** (`races.test.ts`, "R1-C04", three tests added): a later revision by a direct call and through the cache, with a later-still one after it and an older one still dropped while the cached data stays; the first snapshot through the cache and a direct call; a save's answer at a later revision, which also starts the refresh it names.

| Command, in `psx/js/` | Result |
| --- | --- |
| `npm test` | 4 files, 115 tests pass, exit 0 |
| `npm run typecheck`, `npm run format:check`, `npm run build` | exit 0 each |
| `node /tmp/psx-loop-check-f1sp5e2m/client-advanced-revision.mjs` (the coordinator's probe) | "Accepted newer same-principal query", exit 0; it exited 2 before |

Still open from the notes, and carried into the server and build batch: an identity check on loader failures that carry layout data (R1-C04 is not closed until then), reconciliation after a stale-revision refusal of an auth action, `replace` on a document navigation, and the history index when a step through history is overtaken.

## After round 2

The items listed as still open above (R1-C04 for partial errors, R2-C02, R2-C03, R2-C04, R2-C05) and the later R3-C01 and R3-C02 are fixed and recorded in [implementation-round-1-server-build-fixes.md](implementation-round-1-server-build-fixes.md), with which of them were independently re-reviewed. Two statements above no longer hold: a document navigation now keeps `replace`, and an overtaken step through history now leaves the index with the page. `npm test` is 220 tests.
