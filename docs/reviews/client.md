# PSX client-side design review

Status: independent design recommendation, not an approved specification or implementation. Scope: real React/TypeScript client below a PHP block; PHP action names produce dollar-prefixed client proxies. PHP exposure syntax is deliberately not invented here.

## 1. Recommended product boundary

PSX is a source format plus a typed request protocol and a small React router/data runtime. It is **not** PHP templating, React Server Components, or React Server Functions. The client portion is an ordinary TSX module: hooks, closures, context, refs, events, third-party React libraries, and ordinary module imports keep their normal meanings.

Three server operations have distinct roles:

- **Loader:** registered to a page/layout route mount, runs for a document request/navigation/revalidation. Produces that mount's initial props. Not a callable client RPC.
- **Query:** explicitly exported reusable, side-effect-free read with typed input/output. Callable outside React and usable through `useQuery`. Importing a component does not execute its PHP.
- **Action:** explicitly exported mutation, always POST, never run during render. Typed success/domain-error result; unexpected failures reject.

Do not expose every PHP function. Do not synthesize React state from PHP variables. Do not make a PHP query automatically execute once per rendered component: React renders are repeatable, concurrent, and discardable.

Keep the public surface small: `Link`, `useRouter`, `useQuery`, one `queryClient`, generated route references, generated query/action proxies, and generated props/types. Use React's own state, transitions, optimistic state, form status, and action-state hooks rather than parallel framework versions.

## 2. Pages, layouts, and reusable components

The server's route registration remains authoritative. A route registers a PSX page and an explicit ordered layout chain. A file path alone must not secretly create a second competing router. Generated route IDs are stable logical identifiers, not source paths or arbitrary PHP callable names.

A page's default export is a normal synchronous React component. A layout's default export receives `children`; ordinary React composition avoids a second `Outlet` abstraction. Layout state is retained while its mount identity remains stable. A layout's mount key includes its explicitly declared identity parameters: changing an organization must not preserve an organization-specific provider as if nothing happened.

Generated types for each module (illustrative names, exact shape):

```ts
interface PageProps<D, R extends string> {
  readonly data: Readonly<D>;
  readonly scope: RouteScope<R>;
}
interface LayoutProps<D, R extends string> extends PageProps<D, R> {
  readonly children: React.ReactNode;
}
```

Generate a concrete `PageProps`/`LayoutProps` alias in the module's virtual type view, or provide a generated type-only import. Reserve and diagnose generated names explicitly. Do not require the user to write `any` or import the page into itself to recover its loader type.

Pages default to remounting when route ID or decoded path parameters change; query-string changes update props without an automatic remount. Layouts persist by mount identity. This must be documented because React does not reset `useState(data.title)` merely because loader data changed. Editors can intentionally key their inner form by resource ID or explicitly reconcile refreshed data; background revalidation must not destroy unsaved inputs.

Plain `.tsx` components are first-class. A `.psx` component may export reusable queries/actions and a normal React component, but has no automatic loader. Its data arrives through props or `useQuery`. Its server operations receive explicit resource identifiers unless intentionally bound to a route scope. A reusable component can appear twice on a page for different records without cross-talk.

Render error boundaries use real React boundaries. Route configuration can provide a loading UI, a render-error component, and a route-error component for loader failures. Error props expose public status/code/message/request ID plus a retry function; never a production server stack. Failed child loaders may preserve successful ancestor layouts when declared independent, but unauthorized loader data must never render briefly.

## 3. Immutable binding: the non-negotiable rule

A generated module-level `$savePost` cannot consult a mutable global `currentRoute` when it runs. Two mounted editors, old closures, background work, persistent layouts, and a navigation during an upload make that incorrect.

Recommended generated types:

```ts
type ReadOptions = { signal?: AbortSignal };
type ActionOptions = {
  signal?: AbortSignal;
  idempotencyKey?: string;
};

declare const routeScopeBrand: unique symbol;
interface RouteScope<R extends string> {
  readonly [routeScopeBrand]: R;
  readonly routeId: R;
  readonly href: string; // canonical same-origin pathname + search
  readonly params: Readonly<Record<string, string>>;
  readonly navigation: NavigationOrigin; // local navigation guard, not credentials
}
interface NavigationOrigin {
  readonly entryKey: string;
  readonly epoch: number;
}

interface Query<I, O> {
  (input: I, options?: ReadOptions): Promise<O>;
  readonly key: (input: I) => QueryKey;
}
interface Action<I, O, E> {
  (input: I, options?: ActionOptions): Promise<ActionResult<O, E>>;
}
interface ScopedQuery<R extends string, I, O> {
  at(scope: RouteScope<R>): Query<I, O>;
}
interface ScopedAction<R extends string, I, O, E> {
  at(scope: RouteScope<R>): Action<I, O, E>;
}
```

- A route-scoped descriptor is **not callable until bound**: `$savePost.at(scope)(input)`. A standalone exported action is callable as `$savePost({postId, ...})` because its context is entirely explicit.
- `.at(scope)` captures a frozen snapshot of route ID, canonical path/search, and mount identity, not a pointer to router state. It returns stable identity for the same descriptor/scope pair. Input is serialized synchronously when invoked; later caller mutation cannot change an in-flight request.
- `scope` is a prop passed into children like any other dependency. Avoid a magic `$scope` global or hidden context lookup in proxy calls. A module mounted under several route aliases has a generated union of allowed scope IDs, checked again at runtime.
- A layout gets **its own mount's scope**, including its declared route identity; it must not accidentally borrow the descendant page's route parameters. The route manifest specifies which scopes each exported operation accepts.
- Scope is not authorization. It contains no captured model, session, transaction, cookie, or long-lived signed authorization capability. Server dispatch resolves the registered route/mount and runs the appropriate middleware, parameter binding, authorization, and action under the current request's identity.
- Do not replay an arbitrary browser-supplied path into an unrestricted handler. Verify operation membership, route ID/path correspondence, mount, parameter decoding, methods, and canonicalization. Query-string parameters used in authorization or data selection remain untrusted input.
- A scope to post A stays a scope to post A after navigating to B. This is useful and safe when authorized; do not silently rebind to B or silently cancel the write.
- A principal/authentication epoch change clears private caches and discards stale read results. Binding does not pin old credentials: requests always use current browser authentication. Server authorization is still required if logout/login happens between binding and execution.

If ordinary CRUD can pass `postId` explicitly, prefer standalone actions. Route binding is useful for truly route-contextual operations, not a requirement to couple every reusable operation to a page URL.

## 4. Router and navigation contract

Suggested exact surface (supporting exported types elided only for standard React anchor attributes):

```ts
type RouteTarget = string | { readonly href: string };
type NavigationResult =
  | { status: 'committed'; href: string }
  | { status: 'superseded' }
  | { status: 'blocked' };
type NavigationOptions = {
  replace?: boolean;
  scroll?: 'auto' | 'preserve';
  state?: JsonValue;
  ifCurrent?: NavigationOrigin;
};
interface Router {
  readonly location: {
    readonly href: string;
    readonly entryKey: string;
    readonly state: JsonValue | null;
  };
  readonly pending: null | { readonly href: string };
  navigate(to: RouteTarget, options?: NavigationOptions): Promise<NavigationResult>;
  revalidate(): Promise<void>;
  prefetch(to: RouteTarget): Promise<void>;
  block(shouldBlock: (next: { href: string; kind: 'push' | 'replace' | 'pop' }) => boolean):
    { dispose(): void; proceed(): Promise<NavigationResult>; reset(): void };
}
declare function useRouter(): Router;
// Link = normal anchor props with href: RouteTarget,
// plus replace?: boolean, scroll?: 'auto'|'preserve', prefetch?: 'none'|'intent'.
```

`useRouter` subscribes to a stable external store with `useSyncExternalStore`; its readonly snapshot changes with committed/pending navigation. `navigate` and other methods have stable identity. `ifCurrent` is checked both when starting and immediately before committing; it prevents an old save from sending the user away from a newer page. An epoch changes for every navigation intent, including Back/Forward and superseding pending navigation; an entry key alone is insufficient.

`routes.posts.edit({post: '123'}, {tab: 'history'})` produces a typed target through generated route builders. Correct percent-encoding, base path, locale prefix, optional parameters, and repeated query values are the generator's responsibility. Raw same-origin URL strings remain allowed for integration. Cross-origin navigation is a document navigation; reject `javascript:` and other non-navigation schemes.

Behavior required beyond the type surface:

- Intercept only unmodified primary-button same-origin eligible anchor clicks, honoring `target`, `download`, `rel`, user `preventDefault`, and native open-in-new-tab behavior. Render real `href`s. Same-document hash changes avoid loader reload and preserve native anchor behavior.
- Latest navigation intent wins. Abort obsolete read fetches as an optimization and separately guard all completions by navigation generation. Aborting alone is not correctness.
- Resolve redirect chains with a bounded limit before committing a navigation. An auth redirect cannot become an endless SPA retry. Distinguish external/document redirects from internal navigation responses.
- For push/replace navigation, load and validate the next route's required data/code, then atomically commit route UI and history in a React transition. Keep the old page interactive while pending. A loader 404/403/500 commits the target URL with its route error view; a transport failure may leave the old page and show navigation failure with retry.
- Popstate has already changed the browser URL. Either commit the target/error state or restore the old entry deliberately; do not leave old content indefinitely under the new URL. Index only framework-owned history entries, preserve unrelated `history.state`, and fall back to document navigation for unknown entries.
- Save scroll per history entry (including configured scroll containers), restore after route layout stabilizes, handle hash focus, and honor `scroll: 'preserve'`. Set document title and focus/announce the new main content for assistive technology. Do not steal focus on mere data revalidation.
- `block` intercepts internal navigation and recoverable same-document popstate. Applications render their own confirmation UI using its handle. Do not promise perfect interception of browser cross-document Back/Forward; use `beforeunload` only while dirty, accept browser limitations, and consider bfcache lifecycle.
- Prefetch is an optional read, uses the same auth-aware cache, never executes actions, respects data-saver/product policy, and has a finite freshness budget. No speculative authentication side effects. Private loader requests default to private/no-store at the HTTP layer.
- `revalidate` captures the current route snapshot on call. A later navigation prevents its old result from overwriting the new route. Multiple requests dedupe; callers receive completion/failure, not a fictitious successful refresh.

## 5. Loaders and reusable queries

A navigation's route envelope contains the matched layout/page chain, mount keys, loader payloads, route errors, public head metadata, protocol/build IDs, and exact scopes. Loader data is installed atomically for that navigation. Do not return an unspecified grab-bag of PHP variables.

Independent loaders may run concurrently; dependencies are explicitly declared and sequenced. The server authenticates before protected reads and controls transaction/consistency requirements. GET/HEAD loaders must be semantically read-only. A prefetch or retry may execute them again.

Reusable query API:

```ts
type QueryKey = readonly [string, string, string, string];
// operation identity, canonical scope, canonical input, authorization cache partition
interface QueryOptions { enabled?: boolean; staleTime?: number; }
interface QueryState<O> {
  readonly status: 'pending' | 'success' | 'error';
  readonly data: O | undefined;
  readonly error: ReadError | null;
  readonly isFetching: boolean;
  refetch(): Promise<O>;
}
declare function useQuery<I, O>(query: Query<I, O>, input: I, options?: QueryOptions): QueryState<O>;
interface QueryClient {
  invalidate(filter?: { key?: QueryKey; tags?: readonly string[] }): Promise<void>;
  clear(): void;
}
declare const queryClient: QueryClient;
```

The conceptual key contains the principal partition and normalized wire representation; the runtime may internally hash it and include operation/schema/build version. No secret is embedded in a public key. Inputs must be deterministic supported wire values. Object key ordering is canonicalized; array order is retained. Route query ordering must preserve semantics for duplicate values rather than indiscriminately sorting away meaning.

`useQuery` dedupes identical requests, subscribes without causing a write during render, and does not invent render-time PHP effects. StrictMode subscription churn must not duplicate irreversible work (queries must be reads regardless). Disabled queries with no cache are `pending` and not fetching. Background failures retain prior data while setting error/status; the UI chooses whether to replace stale content. Do not expose a fake Suspense contract that creates a fresh promise every render.

Cache entries have bounded lifetime and garbage collection; default stale time is zero. Retry only safe reads with a documented bounded backoff, respecting Retry-After; never retry auth/validation errors automatically. Unmounted subscribers do not receive local state writes. Shared fetch cancellation is reference-counted. Old responses cannot overwrite newer generations after invalidation.

`queryClient.invalidate` marks entries stale synchronously and awaits active refetches; no filter means all private query entries. Tags are server-declared opaque dependency identifiers included in query/loader metadata. Mutation responses carry authoritative invalidation tags after commit. The runtime invalidates matching queries and route loaders, but **does not delay action success until every refetch succeeds**. A saved mutation followed by a failed refresh is still saved.

Loader cache and query cache are conceptually distinct; initial loader data seeds a query only through an explicit operation key/schema-compatible server envelope entry. Never guess that structurally similar JSON represents the same resource. Use a finite per-tab cache by default; persistent or shared caches need explicit opt-in, auth partitioning, schema migration, and logout deletion.

Interop: expose generated callable proxies and stable `.key(input)` so applications may use TanStack Query instead. Do not run two competing caches for the same data. The adapter must consume the same invalidation metadata; document the ownership choice.

## 6. Actions, results, errors, and concurrency

```ts
type ActionResult<O, E> =
  | { ok: true; data: O; redirect?: { href: string; replace: boolean } }
  | { ok: false; error: E };
// E is the operation's generated discriminated union of expected domain failures.
// For example:
type SaveError =
  | { kind: 'validation'; fields: Record<string, readonly string[]>; message?: string }
  | { kind: 'conflict'; currentVersion: string; message: string }
  | { kind: 'forbidden'; message: string }
  | { kind: 'unauthenticated'; loginUrl: string };
type ActionState<O, E> = { status: 'idle' } | ActionResult<O, E>;
```

Expected failures are values. A transport outage, malformed protocol, unsupported build, or unexpected server exception rejects with a sanitized typed error. Include request ID and, for mutation transport failures, `outcome: 'not-sent' | 'unknown'`; do not label a lost response as a failed write. Aborting a submitted request does not undo a server commit. No automatic mutation retry, including after session expiration or asset/build refresh.

Global middleware may deny any operation, so the framework's public authentication/authorization/rate-limit failure union must be included in every generated action result, not just operations whose author remembered to declare it. HTTP transport/status and typed envelope are both checked. Never parse a reverse-proxy HTML 413/502 page as an action result.

An action result's optional redirect is **data, not an unconditional navigation side effect**. Caller opts in:

```ts
const save = $savePost.at(scope);
const result = await save(input);
if (result.ok && result.redirect) {
  await router.navigate(result.redirect.href, {
    replace: result.redirect.replace,
    ifCurrent: scope.navigation,
  });
}
```

This makes background saves predictable. Auth middleware action failures use a typed `unauthenticated` result, not a fetch redirect to an HTML login page. The UI may navigate with the same guard.

Mutation concurrency is not a generic last-write-wins UI feature:

- Separate proxy calls run concurrently by default. React `useActionState` provides its own sequential action queue for a particular hook instance; it is not a global write lock.
- A per-form button may be disabled while pending, but the server still enforces uniqueness and concurrency. Record version/ETag preconditions produce a typed conflict; use server atomic compare-and-write, not only client request ordering.
- Autosave must serialize writes or send version preconditions. Ignoring an old response does not stop an old write committing last.
- Every invocation captures input and scope. Query/read completion is guarded by generation; mutation responses resolve to their original callers. No late response overwrites another form's state via a shared singleton.
- Server invalidation applies even if the initiating component unmounted, unless the auth partition changed. Action-returned redirects/toasts/draft updates remain scoped to the initiator rather than blindly affecting a new page.
- `idempotencyKey` is useful only for operations explicitly supporting it: server deduplication binds principal, operation, resource, and payload hash, persists the result, rejects conflicting reuse, and has a declared expiry. Keys are not a claim of exactly-once delivery. An ambiguous result without server deduplication must not offer a blind retry as safe.
- Optimistic UI uses React `useOptimistic` or an external data library, with explicit rollback/conflict handling. PSX must not patch arbitrary loader data by guessing entity identity.

## 7. Real React forms and useActionState

Checked the installed React 19.2 type declarations in `crabsmith/client`: `useActionState<State, Payload>` expects `(previousState, payload) => State | Promise<State>` and returns `[state, dispatch, isPending]`. A generated `(input, options?)` action is **not** that reducer. Do not tell users to pass `$savePost` directly to `useActionState` or assume React omits previous state.

Use an ordinary small adapter; previous UI state does not cross the network unless intentionally included in input:

```tsx
const save = $savePost.at(scope); // generated Action<FormData, Post, SaveError>
const [title, setTitle] = useState(data.post.title);
const [state, submit, pending] = useActionState<ActionState<Post, SaveError>, FormData>(
  async (_previous, formData) => save(formData),
  { status: 'idle' },
);

return (
  <form action={submit}>
    <input name="title" value={title} onChange={event => setTitle(event.target.value)} />
    <button disabled={pending}>Save</button>
    {'ok' in state && !state.ok && state.error.kind === 'validation' &&
      <p role="alert">{state.error.fields.title?.[0]}</p>}
  </form>
);
```

Critical caveat: a fulfilled React form action is successful **to React** even when its returned state contains validation errors. React can reset uncontrolled inputs after a fulfilled action. The example therefore uses a controlled editable value; uncontrolled inputs need an explicitly designed draft-preservation strategy. Returning `{ok:false}` does not inhibit React's reset behavior. Do not throw validation errors merely to exploit reset behavior.

Other required React semantics:

- A `<form action={function}>` action takes `FormData` and is handled as a POST-style action by React; it is not a PHP URL. Passing a proxy returning a domain result directly is not the same as a React `void | Promise<void>` form callback. Wrap deliberately.
- Imperative `submit(formData)` from `useActionState` must run inside an action/transition context (for example `startTransition(() => submit(formData))`) for pending semantics. Calling the promise proxy in `onClick` works, but does not automatically create React pending UI.
- `useFormStatus` must be in a descendant of the form it observes, not the component that creates that form. It observes React form submissions, not every request to the same server action.
- Throws from a React action go to the appropriate React error boundary. Expected network recovery in-place should be caught in the adapter and mapped to an explicitly typed local UI state. Error boundaries do not generally catch arbitrary uncaught event-handler promise rejections.
- Queueing in a single `useActionState` instance does not serialize distinct forms/hooks. If a resource scope changes, key/remount the editor to avoid old queued submissions becoming state for a new resource. Captured action/scopes must remain immutable.
- `useActionState`'s optional `permalink` does not provide progressive enhancement for arbitrary custom RPC functions. It relies on a compatible server-function integration. PSX must not claim native React Server Function identity or pre-hydration submission behavior without implementing that integration.
- Ordinary GET search/filter forms can remain native forms or be intentionally intercepted into router navigation. They are not mutation actions. Submitter names/values and `formAction` overrides must be preserved when manually constructing FormData (`new FormData(form, submitter)` where supported).

Progressive enhancement is an explicit product capability, not a free consequence of JSX. If required, provide a dedicated **native form protocol**: generated POST action URL + hidden operation/scope/CSRF metadata, server validation, and POST/Redirect/GET with safe flash result/draft transfer. It must work before JS and with JS disabled. Keep this separate from React function-action forms; a small framework `Form` can encapsulate it only if its native versus hydrated contracts, field preservation, validation, and upload behavior are fully specified. Do not introduce a misleading one-line adapter that promises both models automatically.

## 8. FormData, files, and long operations

A form action declares a form input schema; its generated input is `FormData`, not a fictional type-safe object. PHP validates names, multiplicity, scalar coercion, optional/empty/absent distinctions, and uploaded files. Use `getAll` semantics for repeated names; do not flatten to an object and lose repeated values. Nested field names have a documented grammar, not unbounded PHP bracket magic.

Transport multipart data without manually setting its Content-Type boundary. Keep framework metadata in a reserved namespace or separate header/envelope with collision detection; do not consume arbitrary user fields. Browser `File` objects become server upload abstractions, never unserializable action output objects. Client filename, MIME type, extension, and claimed size are untrusted. Validate actual limits/content, handle temporary-file cleanup, and protect download access.

Production requirements include aggregate size/file-count limits, 413 mapping from the reverse proxy, request timeout behavior, CSRF validation before expensive processing where possible, no automatic retry, and clear canceled-versus-unknown outcomes. The baseline callable API supports uploads but cannot claim byte progress using ordinary fetch. A separate optional transport adapter can report progress (XHR) without a second action protocol. Large/resumable uploads should use explicitly authorized staged/direct storage upload + a finalization action; do not buffer gigabytes in a JSON RPC endpoint.

Long-running jobs return a typed job ID promptly and use a query/polling or separately authenticated streaming endpoint. Do not keep a React action and a PHP request open indefinitely to represent a job.

## 9. Serialization and generated types

Recommend a deliberately constrained wire model rather than implicit rich-object revival:

```ts
type JsonValue = null | boolean | number | string | readonly JsonValue[] |
  { readonly [key: string]: JsonValue };
```

The application-facing generated schema is more precise than `JsonValue`. Scalars, lists, string-keyed records, typed DTOs, literal/discriminated unions, and nullable/optional fields are supported. Wire null versus omitted is explicit. Reject unsupported shapes at build time when knowable and at the server boundary otherwise.

- PHP integers outside JS safe-integer range must be declared/encoded as decimal strings; IDs and monetary decimals generally use strings. Do not silently round. Floats must be finite. `undefined`, NaN/Infinity, PHP resources, closures, cycles, arbitrary object graphs, Date objects, maps/sets, and browser File in ordinary JSON are rejected.
- Dates/times are explicitly schema-typed ISO strings with timezone/precision rules; decimals/big integers are strings. No global heuristic turns every date-looking string into a Date.
- PHP empty arrays are ambiguous: schema decides list `[]` versus record `{}`. Sequential list keys, string-keyed record keys, mixed numeric keys, and sparse arrays have defined validation; no magic `array` to `any` mapping.
- Only explicitly declared output DTO fields serialize. Do not expose an ORM object through reflection or generic `jsonSerialize` and hope it excludes password hashes/private relations. Unknown internal fields are rejected or intentionally stripped according to a documented schema rule.
- Server validates every input at runtime; TypeScript is not a security boundary. Client validates protocol/schema compatibility and payload shape before trusting a response. Output validation catches server drift before private internals accidentally reach clients.
- Error field paths use a stable escaped notation or path arrays for nested fields; simple `Record<string,string[]>` examples do not settle that grammar. Error text is rendered as React text, not HTML.
- Limits on body size, nesting, collection counts, and parsing work defend both ends. Guard dangerous property keys/prototype pollution in decoders and merge code.

Use a build-known DTO/schema subset or explicit schema declarations for PHP types not inferable from signatures. Arbitrary PHP execution or heuristic source inference cannot produce sound TypeScript for `array`, dynamic returns, reflection, and serializers. Fail the build with an actionable diagnostic instead of silently generating `any`.

## 10. SSR and the document boundary

Client React is the core; SSR is a deployment mode, not PHP pretending to evaluate JSX. React HTML SSR requires a JS runtime running the generated server-renderable TSX graph. PHP still owns routing, auth, loaders, and actions. A renderer receives only the authorized serializable route envelope, never a PHP request object or database/session handles.

Specify two supported modes clearly:

1. **CSR document mode:** PHP returns a safe shell + initial route envelope; React `createRoot` renders it. No promise of content SEO or no-JS application behavior.
2. **SSR document mode:** PHP resolves the same envelope, the JS renderer renders the same React tree, and `hydrateRoot` uses identical data, build, scope, and mount keys. Root loader values are not refetched just because hydration begins.

No implicit RSC directives, async client components, or PHP calls inside React render. Components intended for SSR must not access browser-only globals during module evaluation/render; browser-only widgets get an explicit client-only boundary. Effects run only in the browser. Server rendering and hydration must have deterministic locale/timezone/IDs and no mutable cross-request global query cache. `useSyncExternalStore` provides a matching server snapshot.

Before flushing SSR, resolve status, redirects, auth, and required head metadata. A stream cannot retroactively change a sent 200 to 404 or redirect. If deferred streaming is offered, define in-stream errors, cancellation, CSP, and which status is irrevocable. Bound renderer time/memory and use a controlled fallback policy; do not hide systemic rendering failures with silent CSR fallback.

Serialize bootstrap JSON in a non-executable script payload with correct `<`/closing-script escaping and CSP integration. Treat loader data as public to that authenticated browser; SSR does not make delivered data secret. Hydration errors should be observable with request/build IDs without logging secrets. Head tags need deterministic deduplication/removal; React metadata facilities can be used, but HTTP status/redirect handling stays server-side.

## 11. Compiler, IDE, build, and deployment safety

A production format needs more than splitting on the first `?>`:

- Parse the top PHP region with correct PHP tokenization (comments, heredocs, strings, closing-tag rules) and define an unambiguous legal boundary. TSX below must remain real TSX, including generics, JSX syntax, comments, and arbitrary dollar-prefixed local variables.
- Extract server registrations/types without executing arbitrary application code during a client build. Create two explicit module graphs: PHP server artifact and stripped TSX client artifact. Client dependencies must never traverse PHP-only imports.
- Generated names are lexical module bindings. Explicitly exported actions create `$name`; collisions with imports, locals, or other generated exports are compile errors. Do not rewrite every `$foo` identifier as an RPC.
- IDE support needs virtual PHP and TSX documents with bidirectional source maps, type diagnostics/completion, rename/find-references for generated bindings, formatting that respects the boundary, and coherent stack traces. CLI typecheck/lint/build must work without an editor extension; CI cannot depend on virtual IDE state.
- Client-facing source maps must not contain the original PSX in `sourcesContent`, the PHP preamble, absolute private source paths, PHP comments, or secrets. Map to sanitized TSX virtual sources; preserve full mappings privately for server diagnostics only. Dev overlays, dev endpoints, error snippets, HMR payloads, editor artifacts, and preview builds are leakage surfaces too.
- Never serve raw `.psx`, generated PHP artifacts, private manifests, or declarations with server implementation comments through the public document root/Vite static directories. Production web server denial is defense in depth, not the only protection. Bundle inspection should prove that sentinel secrets and PHP source do not appear in any public output.
- The public manifest includes only public operation IDs/schema metadata/route assets. Operation IDs are opaque dispatch identifiers, not security tokens. All authorization checks survive a forged client knowing every ID.
- HMR can preserve React state for TSX-only compatible edits. Changes to exported schemas/operation identities, PHP registration, or route mount contracts invalidate the appropriate artifacts and refresh safely; never replay a mutation to recover from HMR.
- Build PHP artifacts, client assets, route manifest, protocol schemas, and optional SSR bundle as one versioned release. Deploy atomically. Retain old hashed assets and a bounded compatibility window for old clients, or return a typed build-mismatch response before executing incompatible operations.
- Client request carries protocol/build/operation-schema identity. Server rejects incompatible writes before deserializing/dispatching. No automatic reload/resubmit on mutation mismatch or ambiguous completion. Preserve editable drafts locally when inviting a user to refresh; sensitive draft persistence is opt-in.
- A rolling release needs explicit old-operation support or graceful write rejection, not merely a fresh HTML shell. CDN caches must not mix private navigation envelopes with public assets, and must vary on the exact request representation if the same URL serves document HTML and navigation data.
- A chunk-load failure during a read navigation may offer one controlled document reload; not an infinite reload loop, and not a reason to replay writes. Service workers must respect the same release and private-cache rules.

## 12. Acceptance scenarios for architecture review

Before calling the design production-ready, write protocol/router/compiler tests for these cases (not implementation requested in this review):

1. Two editors share one imported `$savePost` descriptor but bind to different records; both save the correct record.
2. Save A starts, navigation B commits, save A finishes; B is not redirected/reset, A's correct cache entries invalidate.
3. A persistent layout action is invoked while two different child routes are pending; its scope never switches to a descendant.
4. Navigation A starts then B starts; A's late loader/code completion cannot commit UI, metadata, history, or scroll.
5. An earlier autosave reaches the server last; optimistic concurrency prevents overwriting the newer persisted edit.
6. A transport fails after commit; UI reports unknown outcome and does not blindly duplicate the mutation.
7. A validation result fulfills a React form action; controlled draft text is preserved despite React reset semantics.
8. `useActionState` receives `(previous, FormData)` correctly; previous state is not accidentally sent as the input/options object.
9. React StrictMode and component remount do not trigger actions; query fetch deduplication and cancellation remain correct.
10. Login identity changes while queries and mutations are in flight; old private data never populates the new session cache.
11. Back/Forward while dirty, unknown history entries, hash links, browser reload, new-tab links, and bfcache restoration behave coherently.
12. Multipart duplicate fields, multiple files, zero-byte files, invalid MIME/content, oversized proxy-level rejection, and interrupted upload retain correct semantics.
13. Large IDs, empty PHP list versus record, nullable/optional fields, decimal money, and ISO timestamps survive typed round trips.
14. Initial SSR and CSR navigation use identical authorized envelope/schema and route scopes; hydration does not refetch or leak cross-request data.
15. Old tab submits after deployment; incompatible writes reject before execution, drafts survive the recovery choice, and no write is automatically replayed.
16. Search all public build/dev artifacts for a PHP sentinel secret, PHP source, private paths, and unredacted server stack traces; none are exposed.

## Bottom line

The hardest design boundary is not JSX syntax. It is the relationship between operation identity, immutable resource/route context, React's actual form/action semantics, and navigation/cache generations. Make that explicit and a small surface can serve a complete product. Hide it in module globals, universal helpers, or optimistic assumptions about React Server Functions and correctness will break under ordinary multi-form and navigation usage.
