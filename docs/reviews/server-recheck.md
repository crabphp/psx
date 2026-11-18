# Backend design recheck

Re-read the revised relevant sections of `psx/DESIGN.md`. **All nine findings from server-final.md are resolved at the design-contract level. No remaining blocking contradictions found in this recheck.** This is approval of a coherent proposed design, not implementation verification.

## Resolved

1. **Cold build and sealing — §§3, 21, 25.B:** explicit collection without an old release, fresh staged validation, and finalization after plugins/setup/ordinary routes remove the bootstrap cycle and early-sealing conflict.
2. **Composite navigation inputs — §§6, 11, 25.A:** layout/page query composition, conflict rejection, whole-composite unknown-field policy, generated route types and binder-owned projections now agree.
3. **Implicit identity versus inherited guards — §§6–7, 17:** required identity is explicitly invocation-local; only declared middleware is inherited. Direct operation protection is no longer implicitly promised by a loader signature.
4. **Query controls and output unions — §§6, 10, 16:** QueryProblem/QueryRedirect, the query error union, success/control envelopes and native/PHPDoc union rules make refusals and redirects representable without implicit navigation.
5. **Layout operation identity — §7:** IDs include owning module and family mount; operation guards target their declaration's module; repeated layouts are refused. Endpoint scope and preserved React identity are distinct.
6. **Strict decoding — §25.D:** policy selection precedes lazy parsing, with bounded shared parsing, duplicate detection, JSON object/list preservation and explicit status outcomes.
7. **Build mismatch — §16:** stable cross-build controls are decoded separately from exact-release success data; removed endpoints and pre-entry provenance have deliberate behavior.
8. **Page/error outcomes — §§6, 8, 14, 16:** successful pages are always 200, partial authorized ancestor context is response-carried, and returned failures versus thrown exceptions/session writeback are distinguished. Execution provenance is not inferred from HTTP status.
9. **Configuration and runtime ownership — §§19, 21–23:** generation-pinned releases, trusted command contexts, named bounds and local private-socket SSR settings close the configuration gaps. Remote SSR is explicitly unsupported rather than incompletely configured.

Also checked the revised shared wrapper, capability-specific action types, explicit service scope constructor, navigation transaction/precondition algorithm and observable navigation failures. They are consistent with the backend contract. Ordinary document-based CookieAuth remains usable without an auth adapter; in-app identity transitions explicitly require the revisioned application adapter and reconciliation policy.

## Remaining blocking contradictions

None identified. No additional optional features or implementation evidence requested.
