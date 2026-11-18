# Round 4 re-check — R4-S01 closed

2026-11-15. Recorded by the coordinator from the independent reviewer's completed test process. The reviewer ran in the existing Codex CLI session with `gemini-4-argon-high`, high reasoning; the implementation fix was made by Claude Code Fable 5.2.

## Scoped verdict

**The reviewed fix batch is accepted: R4-S01 is closed, with no confirmed finding left open from rounds 1–4.** This combines the independent round-4 verification of the other fixes with the completed actual-source re-check below. It is not a production-readiness or exhaustive-security certification; the remaining design acceptance gates still apply.

## What was verified

The reviewer's final isolated harness was:

`/tmp/psx-r4-final-j7fxo3_0/r4-s01-recheck.php`

It loads the corrected `Families.php` from the actual project before the snapshot autoloader. The coordinator read the harness and its complete result and checked the finished helper terminal's exit status.

- Helper: `psx-r4-s01-clean` (`t2sr`), **exit 0**.
- Final marker: `ALL_R4_S01_RECHECK_DONE`.
- Captured output: `/tmp/psx-r4-s01-independent.log`.
- Corrected `Families.php` SHA-256: `ab99c2b552fce9d5d9a260c66509439e32c2abd0eee33dbd72dd3e2ab963e8ab`.

Nine negative compilation cases independently reject unsafe integer enum declarations with a source file/line and no generated unsafe TypeScript literal:

1. DTO field named `enum`.
2. Nullable DTO field named `enum`.
3. Enum list field named `enum`.
4. Nested DTO fields and parameter named `enum`.
5. List named `enum` containing DTOs with an unsafe enum field.
6. Query `#[FromQuery]` parameter named `enum`.
7. Nullable query `#[FromQuery]` parameter named `enum`.
8. Loader `#[FromQuery]` parameter named `enum`.
9. Negative out-of-range backing value on a field named `enum`.

The same harness then completes all positive/runtime checks: safe positive/negative boundary literals and quoted numeric-looking strings are generated correctly; ordinary and nested safe actions succeed; a safe query succeeds; a string-backed enum holding `'9007199254740993'` succeeds; out-of-range numeric action/query input is refused with 422 and `not-entered`.

The coordinator separately compared all **497 production files** in the round-4 inventory with current source. Only `psx/src/Compiler/Families.php` differs, by the `array_is_list($value)` condition and its comment. The framework and client production source remain unchanged from the verified checkpoint. New compiler tests and documentation are additional non-production changes.

## Verification problems disclosed

The initial expanded scratch harness included an enum-typed route parameter, which is not a supported framework declaration. A subsequent rewrite lost namespace backslashes and interpolated PHP variables inside generated source strings. Those were harness errors, not new product findings; the final corrected harness preserves literal PHP source and tests supported declarations.

The reviewer session subsequently reported `400: no active upstream websocket for response.interrupt` **after** helper `t2sr` had finished successfully. That transport error prevented a final reviewer message; it does not change the observed exit-0 test result. The coordinator records the result here rather than claiming an additional model-generated sign-off or retrying completed work.

## Routine checks independently run by the coordinator

- PSX PHP: **173 tests, 1,133 assertions**, exit 0 after R4-S01.
- PSX formatting and lint: exit 0 after R4-S01.
- Log: `/tmp/psx-r4-s01-coordinator.log`.
- Prior unchanged-source checks: client **222 passed**, demo PHP **6 passed**, framework **2,412 tests / 44 skipped**, plus typecheck/build/format/lint as recorded in `coordinator-validation.md`.

See `implementation-round-4-final-fixes.md` for the independently verified earlier checkpoint and `implementation-round-4-compiler-fix.md` for the implementer's change and regression evidence.

## Remaining scope

The package is still unreleased and not declared production-ready. `docs/STATUS.md` remains authoritative for uncompleted design gates, including editor tooling, deployment/performance acceptance, and real-browser multi-tab/versioned-auth coverage. Strict `vendor/` privacy remains the chosen policy; a public-package allowlist is not part of this task.

No commits, pushes, registry publication, or deployment were performed. The existing preview was kept running without rebuilding or restarting it.
