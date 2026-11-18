# PSX implementation review, round 1 — early client findings

Reviewed 2026-11-15. These are confirmed defects against `docs/DESIGN.md`, not a review of the status report. This early batch is for the supervised fix loop; the IDs will remain unchanged in the final report. No production source was changed by this review.

Source attribution: pre-fix authored-source snapshot `/tmp/psx-review-baseline-6gjmw6zu/psx/js/src/`. Actual working-tree TypeScript was compiled, without editing it, into `/tmp/psx-r1-repros-GH7CnoFu/dist`. Reproduction source: `/tmp/psx-r1-repros-GH7CnoFu/client.mjs`; observed results: `client.log` in the same directory. The test uses JSDOM, the actual Runtime/RouterCore/QueryCache, and controlled protocol responses. It does not contact or change the demo.

Commands run in visible hc terminals:

```sh
cd /tmp/psx-r1-repros-GH7CnoFu
node_modules/.bin/tsc -p tsconfig.json
node client.mjs
```

Compilation passed. After correcting a syntax typo in the scratch harness, all eight defect observations reproduced (exit 0, terminal `psx-r1-client2`, `t2m0`). The assertions establish **current broken behavior**, not acceptance of the implementation. Keep corrected regression tests in the package asserting the expected behavior below. The hc shell used Node v22.22.2.

## R1-C01 — High: document navigation bypasses stale-origin checks and blockers

**Location:** `js/src/router.ts:259-271`, especially the early `leave()` at 262–265.

**Trigger:** Capture page A's `scope.navigation`, navigate to page B, install a blocker, then let A's delayed action call `navigate('/ordinary-login', {ifCurrent: oldOrigin})`. The target is a same-origin ordinary route outside the PSX route table. External HTTP(S) targets take the same branch.

**Observed:** Resolves `status: 'document'` and calls the document-navigation function, despite both the stale origin and the blocker. Repro prints `stale ifCurrent + blocker bypass: document http://localhost/ordinary-login`.

**Expected / contract:** Design §§9, 11, 13: `ifCurrent` is checked before any navigation side effect; a late save from A cannot redirect B. Owned imperative navigation must honor applicable dirty-navigation blocking before leaving the document.

**Impact:** An otherwise correctly guarded delayed save/login redirect can discard a newer editor's draft.

**Narrow fix / regression:** Run origin checks and the intent/blocker lifecycle before either SPA or document navigation. Test stale and current origins for ordinary and external targets; a current blocked document target must not leave until explicitly proceeded.

## R1-C02 — High: navigation origins do not identify the navigation that created them

**Location:** `js/src/router.ts:248`, `259-271`, `354-368`, `753-759`; `js/src/types.ts: NavigationOrigin`.

**Trigger:** Capture A's origin; `navigate('/two', {replace:true})`; then a delayed A callback calls `navigate('/three', {ifCurrent: oldOrigin})`.

**Observed:** The old callback commits `/three`. Replacement kept the entry key, and `origin.epoch` is only the auth epoch. `current()` has no navigation generation to distinguish A from the replaced page. Similarly, a held/settled intent does not invalidate old callbacks: `abandon()` changes a generation that no origin carries.

**Expected / contract:** Design §11 explicitly requires comparing the current entry/**intent** snapshot, superseding old origins when a new intent is allocated, and publishing fresh origins after settling/resetting an attempt. A guarded navigation's own newly allocated generation must remain valid.

**Impact:** The documented late-action protection fails for replacement navigation and held/failed intents, even on PSX routes.

**Narrow fix / regression:** Track a navigation-intent version independently of auth identity; include/associate it with immutable origins, invalidate old versions on every intent, and republish the active page's scopes at settlement. Test replace A→B, blocked/reset navigation, and a valid current-origin redirect that does not cancel itself.

## R1-C03 — High: the auth reconciliation barrier permits writes and stale reconciliation commits

**Location:** `js/src/runtime.ts:256-267`, `297-319`, `338-351`; `js/src/router.ts:380-419`.

**Trigger / observed:** Call `runtime.authChanged()` and hold its reconciliation GET pending. A saved action binding can immediately send a POST: `transitioning` is false, while only the router's `reconciling` flag is set. Repro confirms one POST succeeds while `reconciling=true`. During the same barrier, navigate to `/two`, then finish the earlier `/one` reconciliation read. Reconcile checks only auth epoch, not its captured navigation generation; it overwrites the page with `/one` while location remains `/two`.

**Expected / contract:** Design §17: writes during an identity transition must wait or receive an explicit refusal; reconciliation may install only for the barrier's latest generation. Clearing private UI alone is insufficient. Committed auth success must remain success even if reconciliation fails.

**Impact:** Old callbacks can mutate using changing credentials. Concurrent navigation can expose a page/scope inconsistent with the URL after the barrier, including operations targeting the wrong displayed resource.

**Narrow fix / regression:** Use one explicit barrier state consulted by all write dispatches, retaining it through reconciliation/document-required state. Reconciliation must own a navigation generation and check it before changing page, auth, or head. Define whether navigation supersedes or waits for the barrier. Test a held GET with attempted POST, a second auth transition, newer navigation, timeout, and successful auth mutation followed by failed reconciliation.

## R1-C04 — High: an older server auth revision can reinstall the previous principal

**Location:** `js/src/router.ts:970`, `978-990`; related `380-419`; `js/src/runtime.ts:189-210`, `269-309`.

**Trigger:** Start with authoritative snapshot `{context:'ctx', revision:'5', partition:'new-user'}`. Answer a navigation with a valid same-build page carrying `{context:'ctx', revision:'4', partition:'old-user'}` and old private data. Such ordering can arise with a delayed response/prefetch across credential transitions; responses must be checked independently of local completion order.

**Observed:** Navigation commits the old data and changes `runtime.auth` to revision 4 / old-user. `adopt()` assigns before any revision comparison; the only numeric comparison is on the special reconciliation path. Query/action response snapshots are not checked at all. The confirmed repro is the navigation case.

**Expected / contract:** Design §17: authoritative monotonic server revisions and partitions govern data installation; an older answer is discarded even when it completes last. Missing/invalid snapshots during adapter-enabled reconciliation cannot establish identity.

**Impact:** The optional in-app auth mechanism can roll the UI/cache partition back to a prior user. A cache clear followed by adopting that old page does not make its data current.

**Narrow fix / regression:** Centralize validated AuthSnapshot comparison for every response/cache installation, compare decimal revisions numerically within the proper context, and reconcile ambiguous changes. Do not overwrite the known snapshot first. Add delayed lower-revision page/query responses, prefetched old pages, changed contexts, missing snapshots, and delayed auth responses/cookies to browser/transport tests. Client checks complement the adapter's required server-side CAS/revision enforcement; they cannot undo browser Set-Cookie order.

## R1-C05 — Medium: concurrent loader revalidations commit in completion order

**Location:** `js/src/router.ts:274-302`.

**Trigger:** Start revalidation A, then B on the same page. Resolve B with newer data, then A with older data.

**Observed:** Final displayed data/head is A's older value (`overlapping revalidation final data: older`). Both reads captured the same generation/entry/auth epoch because revalidation never allocates its own read version.

**Expected / contract:** Design §§11–13: later reads/invalidation must not be overwritten by older responses; successful mutations schedule safe refreshes without making a successful write look failed.

**Impact:** Rapid saves or explicit refreshes can make a just-updated page visibly revert. Route-change checks alone do not order reads of the same route.

**Narrow fix / regression:** Give loader refreshes a version that invalidation/revalidation advances, or serialize/coalesce them with a trailing fresh read. Keep route/auth generation checks too. Test two refreshes resolved in reverse order and overlapping successful mutations whose refreshes return out of order.

## R1-C06 — Medium: immediate query resubscription inherits an aborted request and never restarts

**Location:** `js/src/queries.ts:85-106`, `110-119`, `149-166`.

**Trigger:** Subscribe to an uncached query; unsubscribe its last listener (aborts transport); immediately resubscribe before the abort rejection settles. Then let the abort settle.

**Observed:** The second subscription sees `fetching=true`, so starts nothing. The rejected request clears fetching, but does not restart for the now-present listener. Final state is `pending`, `isFetching=false`, with exactly one aborted request and no data/error. This lifecycle is also relevant to React StrictMode's subscription setup/cleanup replay.

**Expected / contract:** Design §12 expressly permits canceling an unused request only if later resubscription remains correct. Enabled subscribed queries must make progress.

**Impact:** A mounted component can remain blank/pending indefinitely until an unrelated refetch or remount.

**Narrow fix / regression:** Detach/invalidate the canceled promise on last unsubscribe or schedule a new request for active enabled listeners after its cancellation settles. Old completion must not clear/install over the replacement. Test immediate and delayed resubscribe, StrictMode, and cancellation of one of multiple subscribers.

## R1-C07 — Medium: invalidation fetches disabled queries

**Location:** `js/src/queries.ts:85-94`, `173-187`.

**Trigger:** Subscribe with `{enabled:false}` to an uncached query, then call `queries.invalidate()` (a previously tagged disabled entry is also reachable through action tag invalidation).

**Observed:** One network request is sent. Invalidation checks listener count only; it does not retain subscribers' enabled status.

**Expected / contract:** Design §12: a disabled uncached query stays pending and is not fetching. `enabled` commonly guards incomplete inputs or a component that is not ready to load.

**Impact:** Invalidation can run queries with missing/invalid inputs and unexpectedly reveal error/loading states or perform expensive reads that the component disabled.

**Narrow fix / regression:** Track enabled subscriptions separately from mere listeners. Mark disabled entries stale without fetching; fetch when an enabled subscriber is present or on explicit `refetch()`. Test all-disabled, mixed enabled/disabled, and toggling enabled after invalidation.
