# PSX implementation review — round 2, corrected client batch

**Result: not accepted yet.** The original C01–C07 counterexamples now satisfy their expected outcomes, but C03/C04 retain material auth failures and the first correction introduced/exposed the findings below. This report was issued early for the supervised fix loop; the appended adjacent checks and R2-C01 verification complete this checkpoint.

The first corrected source and tests were copied before further edits to `/tmp/psx-r2-client-abnbarmn/{src,test}`; its fix report is `fixes.md`. All line references below are to that immutable snapshot (same paths under `psx/js/` at the checkpoint). `node_modules/.bin/tsc -p tsconfig.json` built that source into its own `dist/`, exit 0, visible terminal `psx-r2-build`. `node review.mjs` uses that actual build with JSDOM and independently controlled network promises, exit 0, visible terminal `psx-r2-repros`; it asserts both corrected cases and the observed remaining defects, so its success is **not** an acceptance result. No production edits were made by the reviewer.

The coordinator independently ran the corrected suite: 112 tests, typecheck, formatting and build all pass. I inspected the new `races.test.ts` cases and StrictMode test rather than treating their pass count as proof of absent races. My harness adds counterexamples they do not cover.

## Round-1 finding disposition at this checkpoint

| ID | Disposition | Independent evidence |
| --- | --- | --- |
| R1-C01 | Original defect fixed | Stale ordinary/document target is superseded; current target passes blocker/reset without leaving |
| R1-C02 | Original defect fixed | Replace and abandoned intent invalidate old origin; freshly published scope can navigate |
| R1-C03 | Partially fixed, remains open | Barrier refuses POST and held navigation stays coherent; stale auth refusal and lock ownership fail below |
| R1-C04 | Partially fixed, remains open | Original stale-principal full page is discarded/reconciled; partial errors still commit private data without valid identity |
| R1-C05 | Original defect fixed | Later successful refresh wins when an older refresh resolves last |
| R1-C06 | Original defect fixed | An abandoned transport completing late cannot poison the resubscribed request |
| R1-C07 | Original defect fixed | Disabled invalidation sends no request; explicit refetch still works |

These dispositions close the concrete original repros, not every design acceptance case in the same subsystem. No real-browser auth adapter/cookie-ordering acceptance is claimed.

## R2-C01 — Medium — Valid newer-revision queries reject after advancing auth knowledge

**Locations:** `src/runtime.ts:241-249`, `446-458` (`witness`).

**Trigger:** Known snapshot `{context:'ctx', revision:'5', partition:'new-user'}`. A valid query success carries the same context/partition at revision `6`.

**Observed:** `witness()` adopts revision 6 and returns `advanced`; `Runtime.read()` rejects every standing other than `current`. The query throws `RequestFailure(kind:'auth')` with a message claiming reconciliation, but no reconciliation happens. The same branch rejects the first valid query snapshot when nothing was known. The new tests cover a higher-revision **navigation**, not the corresponding query success.

**Expected:** Return valid query data while advancing identity knowledge. This is also the behavior promised by the fix report. Older or different-principal responses must still be handled conservatively.

**Evidence:** `review.mjs` prints `newer same-principal query rejects after adopting revision=6`. The coordinator independently reproduced it against the actual built runtime and subsequently reports a correction with 115 passing tests and a positive query probe. The subsequent positive verification is recorded at the end of this report: **independently verified fixed** in the later captured query correction; the historical finding remains recorded.

**Narrow fix / tests:** Admit `current` and `advanced`; test direct query and subscribed cache paths for both a first snapshot and a later same-principal revision. Assert data, snapshot and absence of a spurious barrier/error.

## R2-C02 — High — Explicit stale auth-transition refusal leaves private UI and writes enabled

**Locations:** `src/runtime.ts:332-334`, `365-375`; design §17 auth state machine step 4.

**Trigger:** An `auth:true` action sent with revision 5 receives a valid stable HTTP 409 problem, code `auth_transition`, execution `not-entered` (the server's stale expected-revision refusal).

**Observed:** The action simply returns `{ok:false}`. There are zero reconciling GETs; the old protected page remains visible; `writable()` is true immediately afterwards. The general early problem return bypasses all identity handling. `review.mjs` records precisely those three assertions.

**Expected / impact:** A stale revision is positive evidence that local identity knowledge is obsolete, even if **this action** was refused before entry. Design §17 says stale/concurrent/lost/ambiguous auth responses always reconcile; refusing this transition does not establish which credential the browser now holds. Other writes and private UI cannot be reopened on that assumption.

**Narrow fix / tests:** Classify stale auth refusals separately from proven current-identity business failures. Enter the reconciliation barrier synchronously before exposing the stale result; clear private state and refuse new writes until current credentials are established or document navigation is required. Preserve the original action's refusal, never retry its POST. Test `auth_transition`, concurrent and unknown outcomes, cookies applied before response processing, and a verified no-change business failure under an explicit identity/provenance contract. S01's execution distinction alone is insufficient identity proof.

**Relationship:** Extends the still-open R1-C03/R1-C04 contract. A blanket “all auth-marked ok:false need no reconciliation” exception is rejected.

## R1-C04 — Still open, High — Partial errors bypass identity admission, and top-level snapshots are discarded

**Locations:** `src/router.ts:690-696` (`admit`), `1098-1111` (`load`), `1216-1224` (`read`); `src/protocol.ts:158-189` (problem result); PHP `src/Runtime/Responder.php:164-200` and `PageHandler.php:159-202` in the package.

**Trigger:** The runtime knows context ctx/revision 5/new-user. A navigation returns a valid problem with a same-build `pageError` containing an authorized ancestor from an older server identity. Test both (a) no auth snapshot and (b) an explicit **top-level** auth snapshot `{context:'ctx',revision:'4',partition:'old-user'}`.

**Observed:** Both navigations commit `old-user-private-layout` and its old head under the target URL. There is no barrier. `admit()` explicitly returns shown for every problem lacking parsed auth, including those carrying private ancestor data.

**The exact field-loss path:**

1. HTTP body contains top-level `auth` next to `kind:'problem'` and `pageError`.
2. `protocol.exchange()` reads the control envelope, then returns only `{kind, problem, execution, pageError}` at lines 180–189. It drops top-level `auth`.
3. `RouterCore.load()` reconstructs `{kind:'problem', problem:answer.problem, pageError:answer.pageError}` at lines 1106–1110, also with no auth.
4. `RouterCore.read()` does try `readAuth(envelope.auth) ?? readAuth(source.auth)`, but top-level auth is already gone. The current server's `pageError` has no nested auth either.
5. `admit()` grants the resulting auth-null problem an unconditional local-epoch exception.

Consequently, merely adding a top-level auth field in the server formatter will **not** fix the current client. The first fix report's claim that the client reads an auth-bearing problem is true for a direct `read()`/bootstrap input, but false for the network control path.

**Expected / impact:** Data-bearing partial errors must establish the same authoritative server identity as successful pages. Local epoch is not sufficient: a response can have been produced under an older server revision without a local transition notification. A payload containing another user's ancestor data cannot be rendered merely because its HTTP status is an expected refusal.

**Narrow fix / tests:** Preserve and validate the snapshot through the stable-control result and router reconstruction; add request-local safe identity to server-produced partial data; reject/clear protected partial nodes when an enabled adapter's identity cannot be established. A generic refusal with no private data may have a different safe rendering path. Test full page, revalidation, Back, prefetch and partial errors with missing, older, different and valid identity. Verify both top-level and deliberately supported nested placement through actual `exchange()`, not only fixtures passed directly to `read()`.

## R2-C03 — High — A completed auth action clears a newer auth action's lock

**Locations:** `src/runtime.ts:309-312`, `342-347`, `372-375`; `src/router.ts:536-540` (reconciliation publishes its opened state).

**Trigger:** Start auth action A. A's success starts reconciliation. Subscribe to router state and, when reconciliation publishes the new page with `reconciling:false`, start auth action B; hold B's POST response. Let A's promise finish, then invoke ordinary write C.

**Observed:** B is still in flight, but A's unconditional `finally { this.transitioning = false; }` clears B's lock. `writable()` is true and C sends the third POST. `review.mjs` confirms the sequence using the actual runtime; the coordinator independently reproduced it against the latest built runtime in `client-auth-lock.mjs`.

**Expected / impact:** One local auth transition may be active; no unrelated write may proceed until the current transition's outcome/identity settles. A completion belonging to A cannot release B's lock. Router subscribers are synchronous public observers, so the interval between barrier publication and an awaiting action's continuation is observable.

**Narrow fix / tests:** Give the transition lock an owner token/generation. Only its owner may release it in success, error or finally cleanup. Test a new auth action started from reconciliation notification, promise continuations and failure/overlapping reconciliation paths; assert C stays `not-sent` while B is active and each action POST occurs exactly once. This extends the still-open R1-C03 guarantee.

## Adjudication of reported choices and limitations

- The AuthState adapter is optional for the default integration using ordinary login/logout document routes. An explicit `app.authChanged()` notification may reconcile without a snapshot when no adapter has ever been known. That does **not** claim versioned in-app auth or cross-tab credential-ordering guarantees. Once an adapter snapshot is known, missing identity on private data cannot be accepted. Server finding S05 remains separate.
- A declared, proven no-change business failure need not automatically mean credentials changed. A stale/concurrent auth refusal is different and must reconcile. The present stable error provenance/identity is insufficient to exempt all `ok:false` responses (R2-C02, S01).
- Dropping an older same-principal **read** without a barrier is a defensible conservative choice, provided it never rolls identity backwards or installs stale data. Valid higher revisions must succeed (R2-C01). A stale auth-transition response must reconcile even if its partition string matches.
- Holding ordinary navigation until reconciliation settles is acceptable if ordering, blockers and bounded document fallback remain coherent. The original conflicting-address repro is fixed. History traversal during the barrier may use document navigation.
- Adding the opaque intent token to runtime-created NavigationOrigin is appropriate for this unreleased API. Update the public documentation/type examples; applications should not construct origins manually.
- Ignoring `replace:true` for document navigation is an API limitation requiring correction, not an accepted semantics change. The disclosed overtaken-history-index issue also remains under adjacent checking; neither is certified by the C01/C02 original repro results.

## Follow-up work

The query correction and adjacent document/history checks are completed below. Re-review subsequent owner-lock/server identity/provenance fixes against the preserved snapshots. Reported passing suites do not supersede the open findings above.

## R2-C04 — Medium — Document navigation silently ignores replace semantics

**Locations:** `src/runtime.ts:49`, `116`, `134`; `src/router.ts:621-623`, `666-682`, `719-725`, `774-780`.

**Trigger:** Call `router.navigate('/ordinary', {replace:true})` for an ordinary route (the same applies to external document navigation). The public option requests replacement of the current history entry.

**Observed:** The actual default runtime callback calls `window.location.assign`, not `window.location.replace`. `history.mjs` substitutes only the browser location methods to record which one the actual default callback invokes; output is `Document replace:true calls assign instead of replace`. The internal `leave(href)` signature carries no replace bit, so a caller cannot recover it. Redirect paths intending replacement also lose this intent when they become document navigation.

**Expected / impact:** Replace must replace the current entry for both client and document destinations. Silently pushing adds an unwanted Back entry and can cause repeated redirects/login transitions on Back. This is a pre-existing limitation retained in the batch, not a newly introduced regression or an acceptable reinterpretation of the public option.

**Narrow fix / regression:** Preserve navigation disposition through leave/redirect and use `location.replace` when requested; extend the injectable test transport accordingly. Test same-origin ordinary and external document targets, direct calls and loader redirects, including blocker proceed/reset and explicit push behavior. Do not turn all document navigation into replace.

## R2-C05 — Medium — An overtaken Back traversal corrupts history bookkeeping and defeats blocker restoration

**Locations:** `src/router.ts:853-858`, `899-918`, `1010-1021` (`popped`, deferred traversal, `write`).

**Trigger:** Navigate `/one` → `/two` → `/three` (owned indices 0,1,2). Go Back to `/two` and hold its GET. While the address bar is at `/two` but the router still shows `/three`, push a new navigation to `/one`. Then install a blocker and go Back again.

**Observed:** The push uses the still-committed router index 2, assigning index **3** to the new entry, even though its physical predecessor is index 1. On the next blocked Back, restoration computes delta -2 and calls `history.go(2)`; there is only one forward entry. The restoration does nothing. The browser remains `/two` while the router's location and page remain `/one`. `history.mjs` independently reproduces the final mismatch with the actual router and JSDOM history. The first slow response completing later is properly superseded, but that does not repair history bookkeeping.

**Expected / impact:** A newer intent must supersede the traversal while preserving the actual browser history position/key/index. A blocked traversal must restore the correct owned entry so URL and content agree. This issue was acknowledged as uncovered in the fix report; it is now a concrete finding rather than an accepted limitation.

**Narrow fix / regression:** Explicitly reconcile the physical traversal position before push/replace and before computing subsequent restoration deltas; clear or transfer traversal state under the same intent ownership rules. Test Back/Forward in flight superseded by push, replace, hash and document navigation, then another blocked traversal in both directions. Assert actual URL, history entry key/index and rendered page, not only promise status.

## Completed adjacent verification and current result

Visible terminal `psx-r2-adjacent` ran `node history.mjs`, then a separate TypeScript build of the subsequently corrected query source and `node query-positive.mjs`, all exit 0. Logs: `history.log`, `query-positive.log`. The later query source is independently preserved in `/tmp/psx-r2-client-abnbarmn/query-fixed-src` and compiled to `query-fixed-dist`.

**R2-C01 is now independently verified fixed:** positive probes succeed for direct queries and subscribed cache entries, both with the first observed snapshot and with revision 5 advancing to 6. Data is returned/cached, identity advances, and no spurious barrier occurs. The original R2-C01 evidence remains in the first snapshot; this closure is limited to the later captured correction.

The completed review of this client checkpoint still does **not** accept the batch: R2-C02, R2-C03, R2-C04, R2-C05 and the partial-error part of R1-C04 remain open. R1-C03 remains open through R2-C02/C03. Subsequent server/client implementation changes must be returned for another actual-source verification. The initial C01/C02/C05/C06/C07 corrections and the later R2-C01 correction are supported by the independent probes recorded above.
