# PSX backend integration review

Research only, 2026-11-15. Inspected framework `AGENTS.md`, `ARCHITECTURE.md`, routing/action handling, contracts, application startup, auth, sessions, errors, development watcher, and `../arc`. Names below are proposals, not existing APIs or approved PSX syntax.

## Recommendation

Make PSX an opt-in package, with a build-time compiler and ordinary declared Crab routes. Do not introduce another HTTP dispatcher, container scope, authentication system, or worker lifecycle. A compiled module is a definition, not a PHP include executed for each request. Initial documents, client navigation, page/layout loaders, standalone reads, and mutations all need explicit contracts; dollar-prefixed proxies alone are not full integration.

The existing framework deliberately targets JSON APIs. PSX is an explicit expansion at the package boundary, not justification to silently change core defaults. Some prose is stale: actual `App::PLUGINS` contains Database, Auth, Cache, Storage, Events, HttpClient; TokenAuth and Session are optional. Consult source rather than assuming session/auth middleware exists.

## Existing integration points

- `Contracts\Plugin::register(Container)` can bind PSX registries/renderers, add settings through `Config::defaults()`, commands through `Console`, and routes through `Contracts\Routing\Router`. `AppBuilder::create()` registers plugins and application setup **before** loading route files. No `boot()` or post-routing plugin hook exists.
- `Router::add/get/post`, `RouteGroup`, and `DeclaredRoute` already support explicit route registration and middleware. Typed generated action classes or `[GeneratedModule::class, 'method']` reuse signature checking, path/query/body validation, request/user/session injection, 422 responses, and worker-local service resolution.
- `Router::input(RouteInfo)` and `signature(RouteInfo)` expose the existing input description and reflected return signature. Reuse these for client bindings rather than inventing a second input schema. An arbitrary `Handler` loses both descriptions.
- `Contracts\Validation\Validator` already exposes `inspect`, `validate`, parameter inspection/validation and schemas. It does **not** expose routing's complete argument-source classification or an action invoker.
- `Contracts\Http\ErrorRenderer` is one application-wide formatting hook. `Problem` has status/message/body/query/path problems and an optional cause. `Http\ErrorResponse` is the existing producer of marked error responses.
- `Contracts\Servers::process('vite', ...)` can supervise a frontend program alongside HTTP; `WorkerPlugin` can own worker resources. Neither is a compile/build-before-start hook.
- `Request::cancellation()` is available for cooperative cancellation of loaders and SSR calls. Keep database, HTTP client, cache and queue behind their existing contracts.

## Proposed author-facing surface

Prefer a package registration object obtained in an application plugin's `register(Container)`; avoid adding a global container helper. An illustrative API is:

```php
$pages = $container->get(Pages::class); // proposed PSX contract
$router = $container->get(Router::class);

$router->prefix('/admin')->middleware(CookieAuth::class)->group(
    function (Router $router) use ($pages): void {
        $pages->page('/posts/{id}', 'resources/pages/post.psx')
            ->name('posts.show')
            ->layout('resources/layouts/admin.psx')
            ->middleware(CanEditPosts::class);
    },
);
```

`Pages::page()` returns a **PSX PageDeclaration**, not Crab's single-route `DeclaredRoute`: its middleware applies to the whole generated route family. Ordinary `Route::get(...)->middleware(...)` cannot silently protect sibling endpoints added earlier. Registration must happen while the same router group is active. Freeze and validate definitions before workers start.

Inside the module, make registration explicit: conceptually `page(load)`, `layout(loadLayout)`, `action(savePost)`, `read(searchPosts)`. These names describe compiler declarations, not free-standing runtime globals. A plain private PHP helper is never remotely callable; imports do not expose their functions. Exact syntax needs a language decision.

Concrete signature semantics:

- `load(int $id, User $user, Request $request): PostPageProps` supplies page props. GET/HEAD has no body. Query inputs use Crab's `#[FromQuery]`; identity/session/request remain server-only injected inputs.
- `loadLayout(User $user): AdminLayoutProps` supplies a separate layout props object, never an implicit merge into page props. Layouts run outer-to-inner, then the page. Return a document/navigation representation containing separate layout IDs and props. Client layout state may survive navigation; server authorization must run again.
- `savePost(int $id, SavePostInput $input, User $user): SavedPost` becomes `$savePost(...)`. The input remains one typed body object. A generated module/class constructor receives services; service parameters must not appear in this public function signature.
- `searchPosts(#[FromQuery] SearchPostsQuery $query, User $user): SearchResults` is a GET read endpoint with no mutation side effects. Reads can be called independently of mounting a page and need their own declared authorization/cache policy.
- An explicitly registered shared module may export reads/actions without a page. Its route declaration owns its middleware. Do not derive shared endpoint permissions from whichever React component imports it.

**Services:** the least surprising PHP surface is a module class with constructor injection and normal methods. If retaining top-level functions is essential, define a compile-time service binding declaration and lower it into generated constructor dependencies; explain this transformation. Do not execute `$db = service(...)` during module loading or capture a request/user/session into a worker-cached closure. Do not add an unscoped runtime `service()`/`request()` helper. Service constructors/factories must not suspend, and a service is never request-scoped merely because it uses `bind()`.

## Endpoint and middleware model

For a page mounted at `/admin/posts/{id}`, generate ordinary listed routes such as:

- `GET /admin/posts/{id}`: HTML document or the explicitly negotiated navigation representation. Both run identical authorization and loader semantics.
- `POST /admin/posts/{id}/_psx/actions/savePost`: mutation.
- `GET /admin/posts/{id}/_psx/reads/searchPosts`: independent read, when exported by that mount.

The suffix is illustrative and must be reserved/collision-checked. Preserve original path constraints and names; never accept the tenant/post ID again from an untrusted ambient page-state blob. Generate paths with named routes, not concatenated client strings. A shared module receives its own explicit mount. Do not use a global `/actions/{id}` dispatcher that bypasses the page's middleware.

The effective chain is global middleware → group middleware → declared layout guards → page-family middleware → operation middleware. Ordinary layout loading is **not** a substitute for guards: actions/reads do not execute page/layout loaders as authorization. A layout guard is an explicit middleware declaration copied to all protected endpoints. Restrict layout loader path dependencies to parameters available to every page mounting it, or validate each mount separately.

`RouteInfo::middleware` contains **class names only**, not configured objects or their identity. Reconstructing middleware from route introspection would lose `new CookieAuth(required: false)` and tenant/rate-limit options. Preserve actual declaration references and order. Router deduplicates the same name/object at its **later** position; two different objects of one class both run.

`CookieAuth` checks same-origin on unsafe methods even without a cookie, so it protects login too. TokenAuthPlugin is opt-in. StartSession alone has no CSRF protection. For public/session-only mutations, provide explicit origin-check middleware independent of token authentication; do not invent session CSRF tokens contrary to the existing auth design. Use the configured public `app.url` behind proxies.

## Exact missing extension contracts / decisions

1. **Action preparation and raw-result invocation.** `Routing\ActionHandler` is concrete/internal, combines input resolution with response conversion, and caches its callable. A PSX orchestrator cannot invoke page/layout loaders using all existing routing semantics through a contract. Either generate typed ordinary route wrappers with explicit constructor dependencies, or extract a `Contracts\Routing\Actions::prepare(method, pattern, action): PreparedAction` contract with input/signature/dependency inspection and `invoke(Request): ActionOutcome` (raw result or validation error response). Do not reimplement argument binding in PSX. A prepared action is immutable apart from worker callable caching; no request arguments live on it.
2. **Startup validation and description contributions.** `App::unmade()` hardcodes routes/listeners/scheduled entries and uses concrete container/router methods. There is no package registry for additional named dependencies or diagnostics. Generated route constructor graphs can reuse existing checking; hidden layout/service registries cannot. Add a declaration-inspection contract accepting dependency entries with their source locations, plus a `describe` contribution contract. PSX source mappings, exports, layout chains and route families should be visible to `describe` and `psx:list`.
3. **Definition finalization.** No after-routes hook exists. Prefer complete synchronous registration or an explicitly called `Pages::seal()` over undocumented late mutation. If the compiler/registry requires whole-program checking after route files, add one general startup-validation/finalization contract rather than package access to `App` internals.
4. **Development/build integration.** `Server::watch()` creates `FileWatcher` with its default `['php']`. Adding a PSX directory to `server.watch` does **not** watch its `.psx` files. Individual explicit files work but miss newly added files. A contract/configuration for watched extensions/dependencies and a build-before-generation-start barrier is missing. Keep PHP changes on process restart, client-only changes on Vite HMR, with atomic publication of a matching PHP/JS manifest. Avoid watching generated output into a restart loop. `Servers::process` alone does not guarantee compiler readiness, and registering Vite unconditionally starts it in production too.
5. **Error creation/composition.** Third-party `ResponseInterface` errors do not carry `Problem`; `RenderedErrors` recognizes only concrete `Http\Response`. PSX needs an approved ErrorResponse facade exception to package boundaries or a contract factory for marked errors. A renderer-composition/representation contract is needed if PSX must coexist with an application's existing renderer rather than replace it.
6. **PSX-owned contracts:** `Pages`/`PageDeclaration`, immutable module/build metadata, `DocumentRenderer`, and a strict wire encoder. Keep these in the package's own contract namespace unless core consumes them. SSR, if included, needs a bounded/cancellable renderer adapter; Crab cannot execute React TSX merely by returning HTML.

## Lifecycle hazards

`ActionHandler::callable()` resolves the class on its first worker request and keeps it for the route's lifetime, including a `bind()` service. Middleware is assembled at worker startup **before** WorkerPlugin start hooks. Never rely on a worker hook to provide bindings needed to assemble middleware. Register bindings earlier and open resources in workers.

Compile PHP definitions and signatures before forking; instantiate services only after forking. Do not `require` a module containing global function/class declarations on every request. No mutable module-level “current props”, identity, session, head tags, or render context. Build a per-request context and carry it on the request or explicit call arguments. If loaders run concurrently later, define session/header/conflict semantics first; sequential outer-to-inner is the safe baseline. Release borrowed connections in `finally`; do not retain one for a page module's lifetime.

Production needs immutable, versioned PHP + JS artifacts with a shared build ID. Reject stale client actions before execution with a defined conflict response; do not retry mutations automatically. Old HTML/assets and overlapping old/new Crab generations must coexist during a rolling reload. A network disconnect does not prove a mutation was rolled back.

## Content negotiation and error pitfalls

- Crab's default error formatter only checks whether `Accept` contains `json`; it does not implement media-range priority or `q=0`. PSX must define exact supported media types/versioning, 406 behavior and `Vary: Accept` (plus any protocol header used to select a representation). Private authenticated document/navigation/read data should default to `Cache-Control: private, no-store`; public caching is explicit.
- Normal action conversion is string → text, null → 204, Generator → SSE, other data → JSON. A proxy that always calls `response.json()` breaks on ordinary Crab results. Generated action/read wrappers must enforce their documented wire result, distinguish undefined/void from null, or deliberately support non-JSON outcomes. Use explicit redirect/result types; do not pretend arbitrary PSR responses have a statically known JSON body.
- JSON scalars currently become a null parsed body; an action treats that as an empty object. Unknown content types also do not automatically become 415. Strict PSX transport must check supported media types and object-envelope shape without bypassing the engine's body/member limits. Files stay multipart uploaded-file streams, never base64 JSON.
- `RenderedErrors::handle()` is outside the whole middleware stack and calls the renderer with the **original request**, not the immutable request enriched downstream with authenticated user/session/path parameters. A global PSX error renderer cannot safely run authenticated layout loaders or use a route-local representation attribute. Prefer a dependency-light error document and classify representation from the original protocol request. Rich route-aware errors need explicit response-carried context / a revised rendering contract, not a global “last route.” Unmatched 404/405 also have no page context.
- CookieAuth with `login:` redirects every refused GET/HEAD, regardless of Accept. A navigation/read fetch can follow that to an HTML login document. Define protocol-aware login outcomes or an auth refusal negotiation extension; error rendering cannot fix this 303 because it has no Problem.
- Error rendering happens **after** session middleware has written its changes. Do not mutate sessions in error templates. An action exception caught by the outer ErrorHandler unwinds past inner middleware postprocessing; session writes, cookies, and route-local CORS can be skipped. Prefer returned expected error responses/typed failure outcomes, and test thrown failures explicitly.
- `RenderedErrors` preserves original headers only where the renderer did not set the same name. A renderer's Set-Cookie can replace the entire original cookie list; it should not casually add cookies. Preserve Allow, WWW-Authenticate, Retry-After, Vary and cache policy. If the renderer fails, Crab logs and returns its original JSON/text error—not necessarily PSX protocol JSON. Client protocol handling must cope with that fallback.
- Safe serialization is a separate output contract: explicit DTOs/props, no automatic identity/session/container serialization, bounded output, defined enum/date/integer behavior. Escape JSON embedded in HTML against `</script>` termination, and make CSP/nonces explicit request data, not worker state.

## Arc

`ArcPlugin` registers the `Arc` singleton and `view:cache`/`view:clear`; it adds no routing, middleware, auth, or error renderer. Arc caches compiled closures per worker and expects restart on changes. It can optionally supply the outer HTML document/error shell, receiving **already prepared** props/assets as explicit data. It is not a React renderer or a PSX action runtime.

An Arc adapter behind PSX's DocumentRenderer is appropriate; requiring Arc for all PSX applications is not. Its existing `view()` helper accesses `App::current()->container` and names concrete classes; that is an existing exception, not a sound precedent for new request/service globals. Never perform suspending I/O from an output-buffered template; prepare data before rendering.

## Required proof before calling this production-ready

Test document and navigation parity; nested layout guards on direct action/read requests; configured middleware object preservation; interleaved requests with different users/sessions; missing services before serving; 401/403/404/405/413/415/422/429/500 and renderer failure; login redirects on reads; multipart uploads; Accept/Vary/cache separation; stale builds and rolling generation overlap; `.psx` add/edit/delete through the single dev command; and an application using an existing custom error renderer plus optional Arc. No implementation or tests were run for this design review.
