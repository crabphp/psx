# Final backend review of PSX DESIGN.md

Reviewed the proposed design, not an implementation. The overall direction is coherent and fixes most of the earlier backend concerns. The remaining items below need decisions in the specification; none requires abandoning PSX. Ordered by production impact. No design/framework edits, implementation, or subagents.

## 1. Blocking — cold-build bootstrapping and registry sealing need one exact phase sequence

**Sections:** 3 (plugin registration/sealing), 8 (Define), 21 (build/discovery/CLI), 23 (missing release refusal), 25.B.

A fresh application must run `psx:init`, `psx:types`, or `psx:build` without an existing release. But definition currently loads a private manifest and validates compiled signatures, while build discovers modules by booting those same definitions; production also refuses missing releases. This is a circular dependency unless a distinct collection mode exists. Section 3 also says the plugin validates/seals its registry, then permits application setup plugins to add declarations. In current Crab, PSX plugin registration precedes setup plugins and ordinary `routes/web.php`, so early sealing cannot see all additions or cross-router endpoint collisions.

**Fix:** specify the sequence and modes explicitly: register an open registry → load listed declaration callbacks and application setup/ordinary route files → finalize after all declarations → validate/serve. In build/inspection mode, collect source declarations without requiring a previous release, compile into a staging generation, then validate generated signatures in a fresh definition process. In serve mode, require the selected complete release and verify declarations against it. `register()` must not seal. Define how CLI command dispatch chooses collection mode before normal serving validation. The finalization contract must run after ordinary routes too, not just after PSX files.

## 2. Blocking — page query schema is not just the leaf loader's schema

**Sections:** 6 input-source table, 7 layout mounts, 11 generated route builders, 12 loaders, 25.A.

All layout loaders and the page loader consume one request query string. The design says the generated route builder's exact query type comes from “the loader declaration,” without defining composition. A layout may require `#[FromQuery] string $locale`, while the page takes `#[FromQuery] Search $query`; the generated builder must include both. Worse, two loaders can interpret `page` differently, or one reject unknown fields required by another. A leaf-only schema produces client-valid URLs that always fail server validation; independently validating complete query objects can likewise make a legal composition impossible.

**Fix:** define a composite navigation input schema at seal time, per page mount. State how fields/defaults/requiredness/rules combine; reject incompatible overlapping fields. Validate one strict decoded query and pass each loader a declared projection, with a deliberate policy for `RejectUnknown`. Generate route builders and the navigation schema ID from the composite, including layouts. Document that independent query endpoints use only their own query schema, not ambient page search. Include layout-only required fields and conflicting shared names in acceptance tests.

## 3. Blocking — loader-injected identity is not family-wide authentication

**Sections:** 6 server-injected identity, 7 layout behavior, 8 request sequence, 12 “All auth and guards still run,” 17.

In Crab, a non-null `User $user` in an action signature causes that invocation to return 401 when no matching identity exists. It is **not middleware** and does not authenticate other methods. Consequently, `load(User $user)` may refuse the document while an exported `#[Query] lookup(...)` or action with no identity parameter remains callable if the family middleware allows anonymous requests. Layout loaders are intentionally skipped for direct operations. This is particularly easy to miss with optional CookieAuth: document access appears protected by the loader signature, but its query endpoint is not. Current “all auth” language could promise inheritance that does not exist.

**Fix:** make an explicit security decision. Prefer: only declared middleware is inherited; identity requirements in signatures apply to that method alone. Require an explicit family/layout auth guard for family protection, warn/reject misleading required-identity loader plus unguarded exports where detectable, and show an anonymous direct-query negative test. If the product instead intends to inherit required identity, make that a named family policy with a generated guard; do not infer arbitrary loader authorization or execute loaders on mutations. State the same rule for service modules and layout-exported queries.

## 4. Blocking — query redirects/failures lack a representable public result contract

**Sections:** 6 data/control types, 10 `Query<I,O>`, 14 redirects, 16 envelopes.

The PHP API permits typed query redirect control values and expected failures, while the JS API promises `Query<I,O>: Promise<O>`. Actions have a result union, but queries have no specified redirect carrier: they must not silently navigate, cannot return `Redirect` as `O`, and `RequestFailure` exposes no public problem/redirect target. `QueryState.error` therefore cannot provide a typed login target or field errors despite those being promised elsewhere. Section 16 shows page/action/problem envelopes, but gives no concrete query-success or redirect envelope. The same issue affects native `DTO|Failure|Redirect` and `PageData|Failure|Redirect` return declarations: constrained PHPDoc agreement with unions is unspecified.

**Fix:** keep `Promise<O>` for successful query data and define `RequestFailure.problem` and a typed redirect/control field (or explicitly choose a separate query outcome union). Specify exactly how a query redirect is delivered without navigation; define query-success, loader redirect, query redirect, and action redirect envelopes/statuses. Give executable PHP examples of native unions plus wrapper-generic annotations and their generated TS output. Reserve control types from ordinary DTO serialization.

## 5. High — layout endpoint identity and operation-specific middleware targeting are underspecified

**Sections:** 6 `operation(string $method, ...)`, 7 generated endpoint examples/layout behavior, 9 scopes, 16 page nodes.

A family contains operations from the page **and every mounted layout**. Two layouts and the page can each expose `save` or `refresh`. The spec uses opaque operation IDs, but does not define their identity inputs or how `PageDeclaration::operation('save', ...)` selects the intended owner. Layout declarations are said to accept middleware/identity, without clearly permitting per-operation middleware. Layout scope examples use `mount: "app"`, while the actual endpoint and guard chain must be specific to the descendant family. The same layout can also appear more than once unless repetition is refused. An implementer could accidentally share an endpoint/guard or bind a preserved layout to the wrong family.

**Fix:** define operation identity as at least declaring module + exposed method + family mount, with layout occurrence identity when repetitions are allowed (or reject repetitions). Enumerate one full route family containing a page and two layout exports, including generated names and precise guard order. Scope `operation()` explicitly to the declaration's own module; allow layout-operation guards on `LayoutDeclaration`, and reject ambiguous cross-module strings. Distinguish stable React layout identity from endpoint mount identity. Ensure navigation to another descendant updates the latter while old callbacks retain the original scope.

## 6. High — strict decoding must precede information loss, including JSON object identity

**Sections:** 8 request sequence, 15 form/query rules, 16 direct JSON body, 25.D.

Section 25.D names shared strict query/form parsing but does not place it relative to ordinary global/auth/route middleware. Current Crab parsing can already normalize/drop query fields and multipart duplicate names; replacing `getQueryParams()` or parsed body after that cannot detect the original ambiguity. JSON also needs an explicit rule: current decoding uses associative arrays, loses `{}` versus `[]`, and maps scalar JSON to absent parsed body. Thus `[]`, `null`, or a scalar can look like an empty body and successfully invoke an all-default DTO despite the protocol requiring an object. Duplicate JSON members likewise disappear before typed validation.

**Fix:** define a route-aware decode policy installed before any lossy parser consumes the relevant input, while preserving existing non-PSX behavior. Raw query/multipart validation must preserve duplicate/name information and streaming upload bounds. Specify JSON root-object validation before associative conversion; choose and test duplicate JSON member behavior rather than leaving it accidental. Reject unsupported Content-Type/charset, malformed/ambiguous input and truncation with fixed statuses. Clarify whether middleware may ask for strictly decoded data before final dispatch and how that remains one parse, not a second unbounded copy.

## 7. High — exact build matching conflicts with decoding a build-mismatch refusal

**Sections:** 16 protocol examples and client checks, 22 exact-release matching, 25.C.

Requests send schema identity, and clients must check response protocol/build/schema, but example response envelopes contain no schema identity. More importantly, an old client receiving `409 build_mismatch` from a new server necessarily receives a different build. If exact response matching is applied before decoding the problem, the promised expected pre-invocation refusal becomes an unknown malformed mutation outcome. Removed/renamed operation routes can hit 404 before a matched-handler build check, making the documented mismatch path inconsistent. “Before invoking user code” is also stronger than the pipeline permits: ordinary global/application middleware can run before the operation check.

**Fix:** define a small stable protocol control/error envelope decodable across builds, separately from release-specific success data. State response schema metadata explicitly, distinguish responding build from requested build, and allow only validated protocol-level mismatch refusals through the normal exact-build gate. Specify selection/formatting for stale unknown operation URLs and missing/invalid headers. Narrow the guarantee to “before loader/action entry,” unless protocol gating is explicitly placed before all application middleware. Include an old-client/new-server test that resolves a known rejected write without retry and without claiming an unknown commit.

## 8. High — status, failure provenance and retained ancestor data need an explicit response outcome

**Sections:** 6 `PageData::status` and `Failure::domain`, 8 step 8, 14 boundaries/outcomes, 25.A/C.

The proposal permits layout and page `PageData::status(int)` but does not say which status wins, which statuses are legal, or what navigation does with successful data under an error status. A loader may return Failure after authorized ancestors loaded, and section 14 promises it can retain those ancestors; the generic marked error mechanism currently carries only `Problem`, not the prepared ancestor chain. Unexpected exceptions unwind session/route middleware before the outer ErrorHandler catches them, so “normal session writeback” is not guaranteed for every error. A status alone also cannot prove a mutation was rejected before entry: application code could commit and then return/throw a 409/422.

**Fix:** define a page orchestration outcome containing authorized partial chain, failing node, selected HTTP status and representation metadata; carry safe context on the response for the formatter rather than reloading layouts. Set status precedence (prefer page-only status or require agreement) and disallow control/no-content statuses that contradict the JSON envelope. Define failure provenance/entry phase separately from HTTP status; require returned expected failures to have appropriate application transaction semantics, and conservatively mark post-entry unexpected failures unknown. Explicitly state exception writeback behavior, or catch at a deliberate inner boundary so response postprocessing can run. Test session cookies and ancestor omission for validation, returned Failure and thrown exceptions independently.

## 9. High — configuration is not yet sufficient to implement the promised bounded/runtime behavior

**Sections:** 19 process/transport/readiness, 21 dev launcher, 22 release selection, 23 settings table.

Section 23 promises unknown-setting rejection and required SSR address/auth/process/memory settings, but does not name their keys/types or separate local versus remote renderer requirements. There is no defined dev-mode input that safely enables Vite without enabling it for production, and no source of the selected release identity beyond a mutable `build/psx/current` path. Limits name bytes/depth/list items but leave query/raw-name/aggregate input structure and renderer IPC input bounds implicit. A coherent implementation cannot validate cross-setting behavior from the proposed table alone.

**Fix:** finish the configuration contract before calling the spec implementation-ready: name local/remote renderer transport settings and mutually exclusive requirements; distinguish process supervision from connecting to an external service; define how `dev` supplies mode without a production default; pin the resolved release directory/manifest once per PHP generation. State which existing Crab settings own each input bound and what PSX adds, including total serialized renderer request bytes and queue deadlines. Ensure every promised limit has an owner, check phase and error outcome; avoid adding duplicate limits when Crab already owns them.

## Overall verdict

Proceed after resolving these contract gaps. The class-based server module, constructor DI, ordinary generated routes, explicit layout/service registration, no mutation replay, optional SSR, and package/core boundary are sound. The strongest remaining blockers are definition/build bootstrapping, composite loader query schemas, the distinction between injected identity and inherited guards, and the query control-result API. These should be resolved in the proposal rather than delegated to implementers as incidental details.
