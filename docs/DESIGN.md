# PSX for CrabPHP — production API and architecture

**Status:** proposed design for review, not an implemented or released API.  
**Date:** 2026-11-15.  
**Scope:** a complete optional PHP + React integration, not only server actions.

The user-confirmed direction is a `.psx` file with PHP on top and real React/TypeScript below. React remains the client renderer. Dollar-prefixed names distinguish generated PHP operation bindings from normal JavaScript. The APIs in this document are concrete proposals; they are not claims that the current framework already supports them.

## Contents

1. [Product and boundaries](#1-product-and-boundaries)
2. [Packages and installation](#2-packages-and-installation)
3. [Application structure and registration](#3-application-structure-and-registration)
4. [The PSX language](#4-the-psx-language)
5. [A complete editing page](#5-a-complete-editing-page)
6. [PHP API](#6-php-api)
7. [Routes, layouts, and reusable components](#7-routes-layouts-and-reusable-components)
8. [Request and worker lifecycle](#8-request-and-worker-lifecycle)
9. [Generated bindings and immutable scopes](#9-generated-bindings-and-immutable-scopes)
10. [React and TypeScript API](#10-react-and-typescript-api)
11. [Navigation, history, and accessibility](#11-navigation-history-and-accessibility)
12. [Data loading, queries, and caches](#12-data-loading-queries-and-caches)
13. [Actions, forms, and concurrency](#13-actions-forms-and-concurrency)
14. [Errors, redirects, and boundaries](#14-errors-redirects-and-boundaries)
15. [Serialization and type generation](#15-serialization-and-type-generation)
16. [HTTP protocol](#16-http-protocol)
17. [Authentication, authorization, and security](#17-authentication-authorization-and-security)
18. [Documents, metadata, CSS, and assets](#18-documents-metadata-css-and-assets)
19. [Server rendering](#19-server-rendering)
20. [Uploads, downloads, and background work](#20-uploads-downloads-and-background-work)
21. [Compiler, editor, and developer workflow](#21-compiler-editor-and-developer-workflow)
22. [Builds, deployments, and compatibility](#22-builds-deployments-and-compatibility)
23. [Configuration and limits](#23-configuration-and-limits)
24. [Testing and observability](#24-testing-and-observability)
25. [Required CrabPHP integration changes](#25-required-crabphp-integration-changes)
26. [Production acceptance gates](#26-production-acceptance-gates)
27. [Delivery order and decisions](#27-delivery-order-and-decisions)
28. [Source review](#28-source-review)

## 1. Product and boundaries

PSX consists of a source compiler, a CrabPHP package, a React runtime, a versioned HTTP protocol, and developer tools.

```text
                          compile, never execute page data
resources/**/*.psx  ─────────────────────────────────────────┐
       │                                                    │
       ├── PHP definitions + private manifest ──> CrabPHP     │
       ├── stripped TSX + client manifest ──────> React       │
       ├── generated types + editor mappings                  │
       └── optional React SSR bundle ───────────> JS renderer │
                                                            │
Browser ── ordinary HTTP ──> Crab router/middleware/validation┘
```

### Guarantees

- The client section is ordinary TSX: React hooks, components, context, refs, events, effects, Suspense for client code, and compatible third-party libraries retain their normal meanings.
- PHP owns routing, authentication, authorization, database access, validation, page data, and mutations.
- The compiler generates the connection. Developers do not manually synchronize controllers, fetch calls, route strings, and duplicated input types for each page.
- No request/user/session state is kept in a shared PHP service or module global.
- No PHP implementation reaches public JavaScript, source maps, HMR messages, or raw-source endpoints.
- All server entry points are explicitly registered, inspectable, and tested through normal Crab HTTP handling.
- Expected failures are handled data. Unexpected failures are observable, sanitized errors.
- A mutation is never silently retried, automatically replayed after login, or resubmitted after deployment.

### What PSX is not

- Not PHP generating an HTML template in place of React.
- Not React Server Components or an implementation of React Flight.
- Not Next.js Server Functions; generated proxies are ordinary asynchronous JavaScript functions.
- Not a new ORM, authentication provider, component library, CSS system, queue, storage layer, or WebSocket server.
- Not a claim that HTTP disappears. PSX owns and generates a small, explicit protocol.

This still has a client/server bridge internally. Its difference from a manually wired Inertia-style workflow is source co-location, generated bindings/types, and direct React composition—not a claim that a bridge can be eliminated.

## 2. Packages and installation

Proposed distribution:

| Package | Responsibility |
| --- | --- |
| `crabphp/psx` | Composer package: declarations, PHP compilation, protocol, loader orchestration, document rendering, commands, tests |
| `@crabphp/psx` | React runtime, generated-binding support, Vite plugin at `/vite`, CLI, typechecking and test helpers |
| `@crabphp/psx/ssr` | Optional JS rendering entry, shipped with the same npm version; no second protocol |
| Editor extension | PHP/TSX virtual documents, diagnostics, navigation and formatting; uses the same compiler |

Initial supported baseline: PHP 8.4+, a pinned compatible CrabPHP release, React/React DOM 19.2+, TypeScript 5.9+, and one tested Vite/Node LTS combination. Exact peer ranges must be verified during implementation, not invented as guarantees now. React is a peer dependency and must not be bundled twice.

Proposed setup commands, once the packages exist:

```sh
composer require crabphp/psx
npm install react react-dom @crabphp/psx
npm install --save-dev typescript vite @types/react @types/react-dom
php cua psx:init
php cua dev
```

`psx:init` writes a minimal explicitly registered app, configuration, entry, and example page. It refuses to replace existing files without an explicit overwrite choice. It does not silently replace application middleware or authentication.

One command starts development. Production client rendering requires PHP and static assets, not Node. Production SSR additionally requires the optional supervised JS renderer.

## 3. Application structure and registration

```text
app.php
routes/web.php                     ordinary Crab routes
routes/pages.php                   explicit PSX registration
app/Http/                          reusable input/output DTOs
app/Actions/                       application services/actions
resources/entry.tsx
resources/pages/Posts/Edit.psx
resources/layouts/App.psx
resources/components/UserPicker.psx
resources/components/Button.tsx
resources/styles/app.css
config/psx.php
vite.config.ts
build/psx/<release>/                private generated PHP, schemas, SSR
public/assets/psx/<release>/        public JS/CSS/assets only
storage/psx/                       runtime files only, never boot dependencies
```

The existing application skeleton does not gain empty folders until used. File placement does not create routes.

### `app.php`

```php
use Crab\App;
use Crab\Psx\PsxPlugin;

return App::configure(__DIR__)
    ->withPlugins([
        new PsxPlugin(routes: ['routes/pages.php']),
    ])
    ->withRouting(routes: 'routes/web.php', commands: 'routes/console.php')
    ->create();
```

Authentication/session plugins remain explicit application choices. Listing `PsxPlugin` alone never authenticates a user or starts a session.

### `routes/pages.php`

```php
use Crab\Auth\CookieAuth;
use Crab\Psx\Contracts\Pages;

return static function (Pages $pages): void {
    $pages->layout('app', 'resources/layouts/App.psx');

    $pages->middleware(CookieAuth::class)->group(
        static function (Pages $pages): void {
            $pages->page('/posts/{id}', 'resources/pages/Posts/Edit.psx')
                ->name('posts.edit')
                ->layout('app');

            $pages->service('/people', 'resources/components/UserPicker.psx')
                ->name('people');
        },
    );
};
```

`PsxPlugin::register()` installs an **open** registry and loads only the explicitly listed declaration callbacks. Application setup plugins and ordinary route files then finish their declarations. A deterministic definition-finalization phase runs **after all of them**: resolve cross-file layouts, expand families, check collisions with ordinary routes, validate dependencies, and seal. The plugin must not seal inside `register()`. This phase validates/materializes declarations; it is not an arbitrary I/O-capable `boot()` hook or request-time discovery. Clean-build collection is a separate mode described in section 21.

A route family is not a single Crab route. Family middleware applies to the document/navigation route and every generated query/action endpoint. It preserves configured middleware objects, order, and identity. It must never reconstruct middleware from a list of class names.

The `Pages` registry is also available through the container in an application's setup plugin. A setup plugin adding declarations must do so before the application-level definition-validation phase seals registries; the core integration for that phase is described in section 25.

## 4. The PSX language

### File grammar

A server-bearing file begins with exactly one `<script lang="php">` block followed by a TSX module:

```psx
<script lang="php">
use App\Services\Posts;
use Crab\Psx\Action;
use Crab\Psx\Inject;

function load(int $id, #[Inject] Posts $posts): PostView { /* ... */ }

#[Action]
function savePost(int $id, SavePost $input, #[Inject] Posts $posts): PostView { /* ... */ }

// Unmarked functions are the file's own helpers.
</script>

import { useState } from 'react';

export default function Page() {
    return <main />;
}
```

- `<script lang="php">` and `</script>` are section delimiters, as in a single-file component: the block is server code, never HTML output. The opening tag is exactly `<script lang="php">`, at the very start of line 1, with no other attributes. The closing tag ends its line; the TSX starts on the next.
- The PHP lexer, not a regular-expression split, locates the closing tag: the first `</script>` that PHP reads as code ends the block, so one inside a string, a comment or a heredoc does not. A statement before the boundary ends with `;` or `}`. A `?>` inside the block is refused, since in PHP it would switch to HTML output.
- The TSX stays bare; it is not wrapped in a `<script>` block of its own.
- PHP after the boundary is not allowed: `<?php`, `<?=` or a second `<script lang="php">` below it is refused, because everything below is given to the browser. PHP inside JSX expressions is not allowed.
- A file that still uses the earlier `<?php` … `?>` form is refused with a diagnostic saying how to rewrite it.
- JSX expressions contain JavaScript/TypeScript only. A PHP `$post` local does not become a JavaScript variable.
- The PHP block contains imports, types, constants and function declarations. A class named `Server` is refused: the compiler makes it. No top-level request logic, DB queries, `echo`, `exit`, mutable globals, or arbitrary includes.
- `declare(strict_types=1)` is applied to the generated PHP. A source declaration may state the same value; conflicting declarations fail.
- User-written namespaces are not permitted inside `.psx`. Each module receives a generated PHP namespace based on its normalized project-relative identity. Module-local functions, DTOs and helpers cannot collide with another page.
- External PHP dependencies use ordinary `use` imports and Composer autoloading. Services are parameters marked `#[Inject]`; request data remains ordinary parameters.
- A file without a PHP block is plain TSX and should normally be named `.tsx`.

### Function contract

- A page/layout can define one `function load(...)`. Its name is the fixed PSX module ABI, not arbitrary function discovery. It is not exported as `$load`.
- A function marked `#[Query]` is a callable read operation.
- A function marked `#[Action]` is a callable mutation.
- Unmarked functions are never client-callable: they are the file's own helpers.
- Functions and all DTO fields have explicit PHP types.
- A service is a parameter marked `#[Inject]` with a class type and no default, by-reference or variadic form. Only `load()`, `#[Query]` and `#[Action]` functions take them; a helper is handed what it needs. One name is one service in a file. `#[Inject]` parameters come before any parameter with a default, as PHP requires of a parameter without one.
- `$this` is refused: there is no object to write.
- A reusable component/service module has no automatic `load()`. It receives React props or explicitly calls a registered query.

Changed on 2026-11-18 from a hand-written `final readonly class Server` with constructor injection. That shape was first chosen because free-function sketches hid dependency injection and module lifetime. `#[Inject]` answers both: dependencies stay in the signature, visible and replaceable in a test, and there is still no global `service()` or `request()` helper. Lifetime is unchanged, because the compiler makes the same class from the functions: one instance per worker, its services taken by its constructor, each exposed function a method of the same signature without its `#[Inject]` parameters that hands its arguments on. The router, binder, type generator and runtime see that class as before; an error names the function's own line.

### TSX exports

A page/layout module exports:

- `default`: its normal React component;
- optional `Pending`: non-destructive navigation loading UI;
- optional `ErrorBoundary`: render-failure UI component consumed by a real React boundary;
- optional `RouteError`: loader/HTTP failure UI;
- ordinary named client exports, provided they do not conflict with generated names.

Layouts receive `children`; there is no second template language or special JSX loop syntax. Pages must not be async React client components.

The compiler inserts lexical bindings for exposed operations, such as `$savePost` and `$searchPeople`. Only those exact bindings are generated. An unrelated `$local` is legal JavaScript. A conflicting declaration/import is a compile error, not a silent rewrite.

Generated type modules are explicit imports:

```tsx
import type { Props } from '@psx/types/pages/Posts/Edit';
```

The path is derived from the configured resource root, generated by the CLI/Vite integration, and understood by the editor. It exports precise props, operation inputs/outputs, and relevant module DTO projections. It does not expose PHP code/comments. No implicit global `Props` type and no wildcard `any` declaration for all `.psx` files.

## 5. A complete editing page

Application types such as `Posts`, `User`, `EditData`, `SavePost`, and `SavedPost` are illustrative application-owned classes, not claimed existing Crab classes. `Posts::saveFor` performs authorization and atomic version checking; PSX does not provide an ORM.

```psx
<script lang="php">
use App\Http\EditData;
use App\Http\SavePost;
use App\Http\SavedPost;
use App\Services\Posts;
use App\User;
use Crab\Psx\Action;
use Crab\Psx\ActionResult;
use Crab\Psx\Head;
use Crab\Psx\Inject;
use Crab\Psx\PageData;

/** @return PageData<EditData> */
function load(int $id, User $user, #[Inject] Posts $posts): PageData
{
    $post = $posts->editableBy($user, $id);

    return PageData::of(new EditData($post))
        ->head(Head::title('Edit post'))
        ->tags('posts', "post:{$id}");
}

/** @return ActionResult<SavedPost> */
#[Action]
function savePost(int $id, SavePost $input, User $user, #[Inject] Posts $posts): ActionResult
{
    $saved = $posts->saveFor($user, $id, $input);

    return ActionResult::ok($saved)
        ->invalidate('posts', "post:{$id}");
}
</script>

import { useActionState, useState } from 'react';
import type { Props } from '@psx/types/pages/Posts/Edit';
import { RequestFailure } from '@crabphp/psx';

export default function EditPage({ data, scope }: Props) {
    const [title, setTitle] = useState(data.post.title);
    const [content, setContent] = useState(data.post.content);
    const [version, setVersion] = useState(data.post.version);
    const save = $savePost.at(scope);

    const [state, submit, pending] = useActionState(
        async (_previous: { message: string }, formData: FormData) => {
            try {
                const result = await save.form(formData);
                if (!result.ok) {
                    return {
                        message: result.problem.fields.title?.[0]
                            ?? result.problem.message,
                    };
                }
                setVersion(result.data.version);
                return { message: 'Saved' };
            } catch (error) {
                if (!(error instanceof RequestFailure)) throw error;
                return {
                    message: error.outcome === 'unknown'
                        ? 'The result is unknown. Check the post before saving again.'
                        : error.message,
                };
            }
        },
        { message: '' },
    );

    return (
        <main>
            <h1>Edit post</h1>
            <form action={submit}>
                <input type="hidden" name="version" value={version} />
                <label>
                    Title
                    <input name="title" value={title}
                        onChange={event => setTitle(event.target.value)} />
                </label>
                <label>
                    Content
                    <textarea name="content" value={content}
                        onChange={event => setContent(event.target.value)} />
                </label>
                <button disabled={pending}>Save</button>
                <p role="status">{state.message}</p>
            </form>
        </main>
    );
}
```

The page is keyed by route and path parameters. Navigating from post A to B remounts this editor. Refreshing A's loader data does not silently overwrite its controlled draft.

On success, the server invalidation tags schedule data refresh. Save success does not depend on that refresh succeeding. A lost action response is not automatically retried.

This example deliberately uses a small React `useActionState` adapter. A typed PHP proxy does not have the `(previousState, FormData)` signature React requires. The controls are controlled because a fulfilled React form action can reset uncontrolled inputs even when the returned value describes validation failure.

## 6. PHP API

All names in this section are proposed PSX APIs. Public runtime service contracts live in `Crab\Psx\Contracts` unless the framework itself consumes the contract; core extension contracts are listed separately in section 25.

### Declarations

```php
interface Pages
{
    public function page(string $path, string $file): PageDeclaration;
    public function layout(string $name, string $file): LayoutDeclaration;
    public function service(string $path, string $file): ServiceDeclaration;
    public function prefix(string $prefix): PageGroup;
    public function middleware(Middleware|string ...$middleware): PageGroup;
}
```

`PageGroup::prefix()`, `middleware()`, and `group(Closure)` mirror Crab's declaration style. Group callbacks receive `Pages`. Groups are immutable configuration views; declarations happen once.

| Declaration method | Meaning |
| --- | --- |
| `->name(string)` | Unique public route/service name; required before seal |
| `->middleware(...$middleware)` | Whole family protection, not only the HTML route |
| `->operation(string $method, ...$middleware)` | Additional guards for an exposed method owned by this declaration's own module; cannot target another layout/page by an ambiguous bare name or remove inherited guards |
| `->layout(string ...$names)` | Ordered outer-to-inner registered layout chain, page only |
| `->rendering('client' or 'server')` | Page rendering mode override |
| `->identity(string ...$pathParameters)` | Layout state identity keys; defaults to all path parameters used by that layout's loader/operations |

A layout declaration accepts `middleware`, `operation`, and `identity`; its name is supplied by `layout()`. It has no standalone document URL. A service declaration has no document render mode or layouts. A layout name may occur only once in one chain; repeated occurrences fail compilation.

The registry refuses cycles, duplicate names, missing files, unavailable path parameters, invalid annotated signatures, incompatible layout mounts, invalid middleware, endpoint collisions, and unsupported wire types before workers accept requests.

### Operations and input sources

| Operation | Allowed client inputs | Server-injected inputs |
| --- | --- | --- |
| `load()` | Route parameters and explicitly marked query fields/object | Request, identity, session |
| `#[Query]` | Route parameters and one `#[FromQuery]` object (or independent marked scalar fields) | Request, identity, session |
| `#[Action]` | Route parameters and one typed body object | Request, identity, session |

PSX actions do not also read query fields. A needed mutation option belongs in the body. This narrows Crab's more general action interface to one predictable client call signature. The captured page search string is not automatically forwarded as action input.

An action body cannot redeclare a path parameter as a second authority for that same identifier. Queries preserve Crab's rule against mixing an object query input with separate query fields.

Session injection requires explicit `SessionPlugin` and `StartSession`. Authentication is evaluated on every request, not captured by a rendered page.

**Only declared middleware is inherited.** `load(User $user)` requires an identity for that loader invocation; it does not protect another method lacking that parameter. A family intended to be private must declare a required auth guard, as the example does. Optional CookieAuth only resolves an identity and is not such a guard. `psx:check` warns about a required-identity loader with an export lacking its own required identity when it cannot establish a known required guard. It must not guess arbitrary custom middleware behavior or automatically expose/protect a method from that guess. Direct unauthenticated endpoint tests establish the intended policy, including intentionally public operations.

### Composite navigation query schema

At seal time, compose the query fields of **every mounted layout loader and the page loader** into one navigation schema. Distinct names join. Repeated names must have identical types, requiredness, defaults and normalized rule metadata; otherwise fail the mount with both source locations. Do not silently weaken a rule or choose one loader's default.

Decode/validate the request once against that composite. Give each loader's typed arguments its declared projection; the original Request still describes the same complete request. For `RejectUnknown`, any participating strict query object makes undeclared names outside the whole composite an error; fields owned by another loader are not unknown. Without that rule, preserve Crab's policy of ignoring unconsumed fields. Generated route builders and schema IDs come from this composite, including layout-only required fields. Independent query endpoints use only their own declared query schema, never ambient page search. Prepared invocation must support these explicit projections without reimplementing argument classification in PSX.

### Data and control value objects

| Type | Core constructors and fluent methods |
| --- | --- |
| `PageData<T>` | `of(T)`, `head(Head)`, `tags(string...)` |
| `QueryData<T>` | `of(T)`, `tags(string...)` |
| `ActionResult<T>` | `ok(T)`, `fail(Failure)`, `invalidate(string...)`, `redirect(Redirect)`, `authChanged()` |
| `Failure` | `validation(fields, message)`, `conflict(message)`, `forbidden(message)`, `notFound(message)`, `domain(code, message, status, fields)` |
| `Redirect` | `to(localPath, replace: false)`, `external(httpsUrl)` |
| `Head` | `title(string)`, `description(string)`, `canonical(httpsUrl)`, `meta(key, attributes)`, `link(key, attributes)` |

These are immutable values. Fluent methods return new values. No static current response, current user, or current head accumulator.

- Plain explicitly typed DTO/scalar returns are allowed for queries/actions and normalized to success. Page/layout loaders must return a DTO or `PageData<T>`; an untyped PHP array is not a props schema.
- Successful `PageData` always produces HTTP 200. Layouts cannot set a competing status. Non-success documents come from `Failure`/`Redirect` and use the route-error contract; 204/304/redirect statuses cannot carry a successful page envelope.
- A page/layout loader may return `Redirect` or `Failure` alongside its data type. Query/action redirects are explicit control values, not arbitrary PSR responses.
- `ActionResult::invalidate` and `authChanged` are legal only on successful results. Invalidation is applied only after application transaction completion and before the response is sent. They are metadata, not a transaction manager or durable event bus.
- A `Failure` has a safe code/message/status and declared field errors, not an arbitrary exception or secret-bearing `details` object. Rich domain results use an explicitly typed application DTO.
- Returning arbitrary PSR responses, generators, file streams, or `JsonSerializable` values from a PSX operation is refused. Keep downloads, SSE, and raw HTTP routes as normal Crab routes.
- Cookie changes for login/logout use a specific `ActionResult::cookie(Cookie)` method, preserving multiple Set-Cookie headers. This is response metadata, never JSON data. The package may use Crab's immutable Cookie value object under the existing value-object boundary exception.

PHP cannot express a generic return type natively. Wrapper methods require one constrained PHPDoc generic such as `@return PageData<EditData>` or `@return ActionResult<SavedPost>`. This supplies only the generic argument; it must agree with the native return type and is the sole output-shape declaration. Unsupported/missing generic information fails compilation rather than becoming `any`.

A native `PageData|Failure|Redirect` return requires a matching `@return PageData<EditData>|Failure|Redirect`. A native `SearchResults|Failure|Redirect` requires no generic annotation; its client success type is `SearchResults`, and the two reserved control classes become query refusal/redirect variants, not DTO properties. A native `QueryData|Failure|Redirect` uses `@return QueryData<SearchResults>|Failure|Redirect`. The compiler compares union members after erasing generic arguments; it refuses narrower, broader, contradictory or unrecognized annotations. `ActionResult<T>` already contains expected failure/optional success redirect, so action examples use that wrapper rather than a redundant union.

`Failure::domain` accepts only safe application codes and 4xx refusal statuses; it cannot impersonate reserved protocol codes such as `build_mismatch` or declare an unexpected 5xx failure expected. Returning a domain failure after durable writes violates the application action contract: reject before committing, or explicitly roll back first. PSX cannot infer rollback merely from a 409/422 status.

## 7. Routes, layouts, and reusable components

### One authoritative route system

Crab remains the server router. PSX's client route table is generated from the sealed server declarations, not a separate manually maintained routes tree. Explicit `Pages` groups own their prefix and actual middleware objects; PSX does not infer them afterward from `RouteInfo`.

A registered page may have several explicit mounts, each with a distinct route name and scope. Generated types include the legal mount union. Two mounts do not share middleware implicitly.

For a page at `/posts/{id}`, example generated endpoints are:

```text
GET|HEAD /posts/{id}                         HTML or navigation representation
GET      /posts/{id}/_psx/q/<operation-id>    query
POST     /posts/{id}/_psx/a/<operation-id>    action
```

Paths use the actual original parameter constraints. `_psx` is a reserved terminal segment within registered families. Catch-all routes and endpoint collisions must be checked against generated paths; a family that cannot be expanded unambiguously is rejected with instructions to use a separate service mount. No universal catch-all PHP function dispatcher.

Operation IDs are deterministic opaque manifest IDs derived from **family mount ID + declaring module ID + exposed method + role**; schema/build compatibility is tracked separately. They are not authentication tokens. The client never chooses a PHP class/method string. The manifest contains generated named routes for each operation, and client URL builders encode parameters rather than concatenate untrusted strings.

For `posts.edit` with layouts `app` and `project`, all exposing `refresh`, there are three distinct query routes:

```text
/posts/{id}/_psx/q/<id(posts.edit, app, refresh)>
/posts/{id}/_psx/q/<id(posts.edit, project, refresh)>
/posts/{id}/_psx/q/<id(posts.edit, Edit, refresh)>
```

Their internal names are `psx.posts.edit.app.query.refresh`, `psx.posts.edit.project.query.refresh`, and `psx.posts.edit.page.query.refresh`. Names are reserved/collision-checked. Common guard order is global → Pages groups → app-layout guards → project-layout guards → page-family guards → owning declaration's operation guards. `page->operation('refresh', ...)` targets only Edit's method; `layout('app', ...)->operation('refresh', ...)` targets app's method on every mount. A layout's React key can remain `app` while its endpoint mount ID changes from `posts.edit/app` to `posts.list/app`.

### Layout behavior

```psx
<script lang="php">
// Optional Server::load() returning the current navigation/user display DTO.
</script>
import type { Props } from '@psx/types/layouts/App';

export default function AppLayout({ data, children }: Props) {
    return (
        <div>
            <header>{data.viewer.displayName}</header>
            <div className="content">{children}</div>
        </div>
    );
}
```

- Load outer layouts, then inner layouts, then the page. The baseline is sequential; concurrency is not implicit.
- Pass each module its own `data` and immutable `scope`. Never flatten every loader result into one object.
- Preserve a layout's React identity while its declared identity keys remain the same. Changing a tenant/organization identity remounts the relevant subtree.
- Refresh authorization and loader data on navigation even when React preserves the layout instance.
- Layout middleware is copied to all descendant page-family endpoints. A layout loader is not a security guard and is not rerun before every mutation.
- Layout queries/actions are instantiated for each page-family mount. Their scope points to that specific mount and guard chain, not a mutable current child page. Their declared path inputs must exist on every mount.
- An action endpoint runs guards and the action, not the whole layout/page loader tree. This avoids accidental read-side effects and unnecessary DB work.

### Reusable components

A plain `.tsx` component has no server registration. A `.psx` component can co-locate query/action code, but its server portion must be registered explicitly with `service()`. Rendering/importing a React component never exposes an endpoint or executes PHP by itself.

```tsx
import UserPicker from '../components/UserPicker.psx';
import { $searchPeople } from '../components/UserPicker.psx?server';
```

`?server` is a client-safe generated bindings module, despite the suffix name. It exports operation descriptors/types only. Directly importing raw PHP, private manifests, or a `.psx?raw` representation in client code is a build error.

A shared service with exactly one pathless mount exports callable operations taking explicit input IDs where needed. Parameterized or multiply mounted service modules always export scoped descriptors, even if one mount happens to be pathless. Select the mount explicitly:

```tsx
import { services } from '@psx/services';
import { $searchPeople } from '../components/UserPicker.psx?server';

const scope = services.organizationPeople.scope({ org: 'acme' });
const people = await $searchPeople.at(scope)({ query: 'Ada' });
```

The generated signature is `scope(params: ExactPathInputs): RouteScope<'organizationPeople'>`; a pathless named service takes `{}`. Its `navigation` is null, it encodes canonical paths using the manifest, and it captures the current local runtime identity without carrying credentials. Service references are not navigable page targets. A service never borrows the ambient page's scope or chooses a guard chain from whichever component imported it.

## 8. Request and worker lifecycle

| Phase | PSX work |
| --- | --- |
| Build | Parse source/types, produce PHP/JS/schema artifacts; no loader/action execution |
| Define | Load private manifest, register ordinary routes/bindings, validate signatures/layouts/DI, seal declarations |
| Worker start | Construct middleware, initialize worker-scoped services/render adapters; open I/O only here or lazily |
| Request | Resolve identity/parameters, invoke prepared loaders/query/action, encode response using local request state |
| Stop/reload | Cancel/drain outstanding work through existing Crab semantics; release resources |

The container keeps server module instances per worker. A `readonly` module is not permission to retain a mutable request object inside another property. Services must hold no per-request identity, props, transaction, head state, or cancellation token.

For a page request:

1. Match the ordinary registered route.
2. Run global, group, layout, family, and applicable operation middleware in documented order.
3. Validate strictly decoded input through the proposed prepared-action contract extracted from Crab's existing binder; apply the compiled composite loader projections.
4. Run layout loaders sequentially and stop on redirect/failure.
5. Run the page loader.
6. Validate/encode authorized data to the declared wire schemas.
7. Return either a navigation envelope or a document, using the same data and policy.
8. Return an explicit page-orchestration outcome through middleware and centralized response formatting; expected returned outcomes preserve normal postprocessing.

A page orchestration outcome contains either a complete chain or the already authorized partial ancestor chain plus failing node, public problem, selected HTTP status and representation identity. On failure, omit that node and its descendants. Carry this safe context with the response; the outer error formatter must not rerun loaders. Unexpected exceptions caught by the existing outer ErrorHandler can bypass inner session/cookie postprocessing; PSX does not promise otherwise. Prefer returned expected outcomes. Tests must distinguish pre-entry validation, returned application failure and thrown exception paths, including session writeback. Cancellation follows Crab's cancellation path and is not swallowed into a success response.

No compile-on-request in production. No `require` of repeated global function definitions. No output buffering around suspending PHP loader work. A failed validation is a returned response/outcome, not an exception used as routine control flow.

## 9. Generated bindings and immutable scopes

This is essential for correctness, not an optional advanced feature.

```tsx
const save = $savePost.at(scope);
const result = await save({ title, content, version });
```

`$savePost` is a module-level descriptor. `.at(scope)` returns a bound callable with a frozen snapshot of the route/mount/path parameters. It never reads a mutable global `currentRoute` when called.

```ts
interface RouteScope<R extends string = string> {
    readonly routeId: R;
    readonly mountId: string;
    readonly href: string;
    readonly params: Readonly<Record<string, string>>;
    readonly navigation: NavigationOrigin | null;
    // Opaque local runtime/schema identity; not a server credential.
}

interface NavigationOrigin {
    readonly entryKey: string;
    readonly epoch: number;
}
```

- The public scope type is branded with exact parameter names. `scope.params` holds canonical path text; route/service-builder inputs use the generated PHP scalar input types. The manifest validates/encodes those inputs, and the server independently binds the URL parameters.
- The server checks operation membership and resolves route parameters from its registered URL. It does not trust a client-supplied PHP target or a blob of serialized server objects.
- A scope contains no model, identity, session, cookie, transaction, secret, or authorization capability.
- Credentials are those of the browser at invocation time. A scope does not pin the user who originally loaded the page.
- `.at()` returns a stable binding for the same descriptor/scope pair. Each invocation snapshots/encodes its input before beginning asynchronous transport.
- An old post-A binding remains post A after navigation to B. It cannot unexpectedly save B.
- A layout receives its own mount scope. When descendant routing changes, layout state may survive while the scope prop is replaced. Existing callbacks still hold their original immutable binding.
- Passing a scope from an incompatible mount fails before sending; the server independently checks the request.
- Standalone single-mount pathless service bindings are callable directly: `$logout({})`, `$searchPeople({ query })`. Multiple mounts require explicit `.at(services.<name>.scope({}))` even without path parameters.

Cross-module imports are explicit via `?server`. The compiler generates `$name` only for exposed operations, not all PHP functions and not every dollar-prefixed JavaScript identifier.

## 10. React and TypeScript API

### Core runtime surface

```ts
// Runtime and navigation
export declare function start(options: StartOptions): PsxApp;
export declare function Link(props: LinkProps): React.ReactElement;
export declare function useRouter(): Router;
export declare function useQueryClient(): QueryClient;

// Data
export declare function useQuery<I, O>(
    query: Query<I, O>, input: I, options?: QueryOptions<O>,
): QueryState<O>;

// SSR/browser-only modules
export declare function clientOnly<P>(
    load: () => Promise<{ default: React.ComponentType<P> }>,
    fallback?: React.ReactNode,
): React.ComponentType<P>;

interface StartOptions {
    root: HTMLElement;
    onError?: (error: Error, context: {
        kind: 'render' | 'protocol' | 'hydration';
        build: string;
        requestId?: string;
    }) => void;
}

interface PsxApp {
    readonly router: Router;
    readonly queries: QueryClient;
    authChanged(): Promise<AuthTransitionState>;
    dispose(): void;
}

type LinkProps = Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & {
    href: RouteTarget;
    replace?: boolean;
    scroll?: 'auto' | 'preserve';
    prefetch?: 'none' | 'intent';
};
```

`start()` reads the validated bootstrap envelope, installs one browser app runtime, selects `createRoot` or `hydrateRoot`, and mounts the generated route tree. It returns stable router/query-client/dispose handles for integrations and tests. Multiple independent PSX applications in one document are not part of this protocol version; multiple ordinary React components/portals are supported.

`StartOptions` includes the root element and an unexpected-error reporting callback. A shared wrapper is configured as `psx.wrapper`, a module exporting a default `React.ComponentType<React.PropsWithChildren>`. Both generated browser and SSR entries import that exact module. DOM startup remains in the browser-only entry; there is no runtime-only wrapper override that could diverge during hydration. Authentication credentials, private PHP config, and protocol transport are not arbitrary user-provided bootstrap overrides. `PsxApp.authChanged()` is the explicit notification for auth changes performed outside generated operations; it follows the reconciliation/barrier rules in section 17.

```tsx
// resources/entry.tsx
import { start } from '@crabphp/psx';
import './styles/app.css';

start({ root: document.getElementById('app')! });
```

The Vite plugin supplies the generated page map. There is no second handwritten route registry in this entry.

### Operation types

```ts
type ReadOptions = { signal?: AbortSignal };
type ActionOptions = { signal?: AbortSignal };

interface Query<I, O> {
    (input: I, options?: ReadOptions): Promise<O>;
    key(input: I): QueryKey;
}

interface Action<I, O> {
    (input: I, options?: ActionOptions): Promise<ActionResult<O>>;
}

interface FormCapable<O> {
    form(input: FormData, options?: ActionOptions): Promise<ActionResult<O>>;
}

interface ScopedQuery<R extends string, I, O> {
    at(scope: RouteScope<R>): Query<I, O>;
}

interface ScopedAction<R extends string, A> {
    at(scope: RouteScope<R>): A;
}

type ActionResult<O> =
    | { ok: true; data: O; redirect?: RedirectTarget; auth?: AuthTransitionState }
    | { ok: false; problem: PublicProblem };

interface AuthTransitionState {
    readonly status: 'reconciled' | 'document-required';
    readonly origin: NavigationOrigin | null;
}
```

The generator emits `Action<I,O> & FormCapable<O>` when both encodings are valid, `Action<I,O>` for JSON-only schemas, and `FormCapable<O>` for file-bearing form-only schemas. `ScopedAction` carries that exact generated capability type; it does not advertise a JSON callable for a file upload. `.form()` input is explicitly `FormData`, not falsely advertised as compile-time field-safe. The object call is statically typed.

`PublicProblem` has a fixed safe shape: `status`, `code`, `message`, `fields`, `query`, `path`, and optional `requestId`, `retryAfter`, and `loginUrl`. Field maps are `Readonly<Record<string, readonly string[]>>`; `retryAfter` is a nonnegative number of seconds. `RedirectTarget` is `{href: string; mode: 'internal' | 'document'; replace: boolean}`. Application-specific structured business outcomes belong in explicit DTOs rather than an untyped error payload.

`QueryKey` is an opaque readonly tuple of build/schema/operation identity, canonical scope/input and local auth epoch. Consumers use `.key(input)`, not a handwritten tuple. `JsonValue` is null, boolean, finite number, string, a readonly list of JsonValue, or a string-keyed record of JsonValue.

Expected query control outcomes have explicit exported error types:

```ts
export declare class QueryProblem extends Error {
    readonly problem: PublicProblem;
}
export declare class QueryRedirect extends Error {
    readonly target: RedirectTarget;
}
type QueryError = QueryProblem | QueryRedirect | RequestFailure;
```

A query's `Promise<O>` resolves only data. It rejects `QueryProblem` for an expected refusal and `QueryRedirect` for an explicit control redirect; neither is an error-tracker incident or an implicit navigation. Transport/protocol/unexpected-server failures use `RequestFailure`. `useQuery` exposes the same union so login targets and validation details are representable.

### Props

```ts
interface PageProps<D, R extends string> {
    readonly data: Readonly<D>;
    readonly scope: RouteScope<R>;
}

interface LayoutProps<D, R extends string> extends PageProps<D, R> {
    readonly children: React.ReactNode;
}
```

Generated concrete `Props` aliases supply `D` and the exact mount union. Module-local server DTO names appear in its generated type module. No server object identity or methods survive serialization.

## 11. Navigation, history, and accessibility

```ts
interface Router {
    readonly location: { href: string; entryKey: string; state: JsonValue | null };
    readonly pending: null | { href: string };
    readonly navigationError: NavigationFailure | null;
    navigate(to: RouteTarget, options?: NavigationOptions): Promise<NavigationResult>;
    revalidate(): Promise<void>;
    prefetch(to: RouteTarget): Promise<void>;
    block(test: (next: NavigationIntent) => boolean): NavigationBlocker;
}

type NavigationOptions = {
    replace?: boolean;
    scroll?: 'auto' | 'preserve';
    state?: JsonValue;
    ifCurrent?: NavigationOrigin;
};

type NavigationResult =
    | { status: 'committed'; href: string }
    | { status: 'superseded' }
    | { status: 'blocked' }
    | { status: 'document'; href: string }
    | { status: 'failed'; error: NavigationFailure };

interface NavigationFailure {
    readonly href: string;
    readonly failure: RequestFailure;
    retry(): Promise<NavigationResult>;
    dismiss(): void;
}
```

`RouteTarget` is a same-origin URL string or a generated route-reference object. External HTTP(S) targets use document navigation. Non-navigation schemes such as `javascript:` are refused. Generated route builders are imported from `@psx/routes`, for example `routes.posts.edit({ id: 42 }, { tab: 'history' })`; the exact query type comes from the composite layout/page navigation schema. Builders do not invent optional-path syntax Crab does not support.

`NavigationIntent` includes target href and `push`, `replace`, or `pop`. A blocker exposes `getSnapshot(): NavigationIntent | null`, `subscribe(listener): () => void`, `dispose(): void`, `proceed(): Promise<NavigationResult>`, and `reset(): void`. Its snapshot has stable identity until changed, so an application can subscribe with React's `useSyncExternalStore` and render its own confirmation. Disposing a blocker cancels its held attempt rather than silently navigating. A new attempt replaces the previous held intent; `proceed()` releases only the recorded intent through the remaining blockers.

`useRouter()` also subscribes through `useSyncExternalStore`; navigation methods keep stable identities and its server snapshot matches the initial envelope. A blocked attempt is not retained indefinitely without a bound handle.

### Required behavior

- `Link` renders a real anchor. Honor modified clicks, buttons, `target`, `download`, browser new-tab behavior, caller `preventDefault`, and hash-only navigation.
- Navigation fetches target code/data without unmounting the current page. A newer navigation intent supersedes earlier reads. Aborting fetch is an optimization; generation checks establish correctness.
- Commit target data, layout/page tree, head, history, and focus as one logical navigation after required data/code are ready. Do not mix a new title with an old page.
- A known loader failure commits the target URL with its error view. A transport failure on push/replace leaves the prior page, clears pending, installs `router.navigationError`, and resolves `navigate()` with `{status:'failed', error}`. Built-in Link consumes this result without an unhandled rejection; the scaffold renders an accessible retry/dismiss slot from that snapshot. Retry allocates a fresh safe navigation subject to current guards/blockers, and returns superseded if its initiating page has since been replaced. A newer attempt clears the obsolete error. Programming errors still reject and reach the configured unexpected-error handler.
- Popstate already changed the URL: commit its result/error or deliberately restore the previous owned entry. Never leave old content indefinitely under a new URL.
- Preserve unrelated browser `history.state`. Track PSX-owned entry indices; unknown/cross-document entries fall back to document navigation.
- Keep per-entry scroll positions, restore Back/Forward, support hashes, and respect `scroll: 'preserve'`. Initially support the document scrolling element; custom scroll containers require explicit registration, not DOM guessing.
- Update document metadata and focus/announce the new main content. Revalidation alone must not steal focus or reset scroll.
- `ifCurrent` is a **precondition before allocating a new navigation**. Compare it with the current entry/intent snapshot and auth epoch. If it matches, allocate a new transaction/generation. At commit check that this new transaction is still the latest permitted intent and has the same auth epoch; do not compare the old supplied epoch with the epoch incremented by its own navigation. Otherwise a valid save redirect would cancel itself.
- A blocked intent owns its allocated generation. `proceed()` may release that generation only while it remains latest and in the same auth epoch; it does not create an unrelated second attempt. Reset/dispose invalidates the held generation. A newer intent supersedes it. The runtime republishes fresh navigation-origin snapshots for the unchanged active page when an attempt settles/resets; old callbacks remain stale while current renders can initiate new work.
- Bound redirect chains to eight hops. A login or unknown-route redirect cannot cause an infinite SPA retry.
- Dirty-form blocking covers owned navigation and recoverable same-document history traversal. Browser cross-document Back/Forward cannot be perfectly blocked; use `beforeunload` only while dirty and respect browser limitations.
- On bfcache restore, compare runtime/build/auth generation and revalidate protected data before treating it as fresh.

Page identity defaults to route ID plus decoded path parameters. Query changes update props without remounting. Layout identity follows declared identity keys. No automatic synchronization of loader data into existing `useState` values.

## 12. Data loading, queries, and caches

### Loaders

Loaders serve documents, navigation, and revalidation. They are not callable RPC bindings. They must be semantically read-only: prefetch, retry, and SSR can execute them again.

The response contains a matched layout/page chain with separate props, identities, scopes, metadata, and data-dependency tags. The runtime installs the chain atomically. It never guesses that arbitrary PHP locals belong in props.

Parent-to-child data is normally ordinary React composition/context. One loader does not receive another's arbitrary DTO automatically. If two loaders need the same read, use an application service or deliberately designed request-local batching through explicit arguments, not a worker-global cache.

Sequential loaders are the baseline. A future parallel mode must specify dependencies, auth ordering, session writes, headers, cancellation, and snapshot consistency before being enabled.

### Queries

```tsx
const people = useQuery($searchPeople, { query }, { enabled: query.length >= 2 });
```

```ts
interface QueryOptions<O> {
    enabled?: boolean;
    staleTime?: number;
    initialData?: O;
}

interface QueryState<O> {
    readonly status: 'pending' | 'success' | 'error';
    readonly data: O | undefined;
    readonly error: QueryError | null;
    readonly isFetching: boolean;
    refetch(): Promise<O>;
}

interface QueryClient {
    invalidate(filter?: { key?: QueryKey; tags?: readonly string[] }): Promise<void>;
    clear(): void;
}
```

- Queries are side-effect-free GETs with typed input/output. All auth and guards still run.
- Requests start after subscription/commit, never as irreversible render side effects. Identical active requests deduplicate.
- Keys include operation/build/schema identity, immutable scope, canonical input, and local authentication partition. A key is not authorization and contains no credentials.
- Object keys normalize; list order remains significant. Repeated query values cannot be reordered in a way that changes their meaning.
- Default stale time is zero. Cache lifetime and total capacity are bounded. No cross-tab persistence, localStorage, service-worker storage, or shared SSR cache by default.
- `initialData` seeds only this exact query key in the current app cache; it is immediately stale unless a declared freshness policy says otherwise. Loader-to-query seeding is explicit, never inferred by JSON similarity.
- A disabled uncached query is pending but not fetching. A failed background refresh retains last data and exposes the error.
- Invalidation increments the entry generation before refetch. Old responses cannot repopulate a newer entry.
- Canceling one subscriber cannot cancel a shared request needed by others. A no-subscriber request may be canceled; later resubscription remains correct.
- Read retries default to none. A configurable safe-read retry policy may allow up to two attempts with bounded backoff/Retry-After; 401/403/404/422 are not retried automatically.
- SSR queries do not fetch independently during React rendering. Pass loader-prepared initial data or render a pending state that fetches after hydration.

`QueryClient.invalidate()` marks synchronously and waits for active matching query refetches; no filter means all queries in this app/auth partition. It does not mean a server-side/global cache was invalidated. `router.revalidate()` separately refreshes the current loader chain.

### Mutation invalidation

Server `tags()` identify data dependencies. Successful action `invalidate()` metadata marks matching query entries and loader chains stale, then schedules their refresh. It is local response-driven invalidation, not cross-user cache coherence.

A lost action response may also lose its invalidation message. After an unknown outcome, the UI can perform a safe read to reconcile. Server-wide caches need application-owned durable invalidation after commit; PSX tags are not a replacement.

Action success resolves independently of refresh success. Refresh failures appear as stale-data errors, not as a falsely failed save.

Apps using TanStack Query can call generated proxies and use their stable keys. A dedicated adapter forwards invalidations; one cache owns a resource. Do not secretly run the built-in cache and a second library cache for the same subscription.

## 13. Actions, forms, and concurrency

### Object calls

```tsx
const result = await $savePost.at(scope)({ title, content, version });
if (!result.ok) {
    // Handle expected validation/conflict/auth/rate-limit failure.
}
```

Normal client calls do not navigate, reset inputs, create toast notifications, or guess how to update React state.

### React forms

```tsx
const save = $savePost.at(scope);
const [state, submit, pending] = useActionState(
    async (_previous, formData: FormData) => save.form(formData),
    initialState,
);
```

The initial state and reducer return union must be explicitly typed when inference cannot establish the idle/result union. No previous UI state is sent to PHP unless the developer puts it in the actual input.

- Use normal `<form action={submit}>` with React 19.
- `useFormStatus` works in a descendant of that form, not in the component creating it.
- Imperative `useActionState` dispatch belongs inside an action/transition context; a plain proxy call does not supply React pending state.
- A fulfilled function-action can reset uncontrolled controls. Use controlled drafts, as in section 5, when invalid submissions must preserve values.
- Expected validation is a result, not an exception used to fight React's reset behavior.
- An action's returned `redirect` is data. The caller can navigate with `ifCurrent: scope.navigation` only when that origin is non-null.
- Normal event-handler promises need explicit error handling. A React render boundary is not a blanket promise rejection handler.
- PSX does not claim that `useActionState`'s `permalink` makes a custom RPC function a React Server Function.

### Plain forms and no-JS behavior

Function-action forms require JavaScript. SSR provides initial HTML, not automatic no-JS mutation support. The entry shell must state this accessibly when JS is disabled.

For a no-JS-critical login/payment/checkout, use an ordinary Crab POST route and HTML form with POST/Redirect/GET. A future PSX native-form adapter must separately specify draft/error flash storage, redirects, CSRF, submitter overrides, uploads, and hydration handoff before it can claim progressive enhancement. Do not ship a half-working native fallback under the same API.

This is a deliberate capability boundary, not a postponed correctness fix: the production SPA form contract is explicit about requiring JS.

### Concurrent writes

- Independent action calls run concurrently. A `useActionState` hook has its own React queue, not an application-wide lock.
- Disabling a button is UI convenience, not server concurrency protection.
- Editing examples include a version field. Applications perform atomic compare-and-write and return a conflict on stale versions.
- Autosave must serialize writes or use server preconditions. Ignoring old responses does not prevent old writes from committing late.
- Abort after sending means the result may be unknown. It does not roll back a PHP transaction.
- Mutations resolve to their original caller even after navigation. They cannot reset another page's draft or redirect it without an origin check.
- No retry on network error, timeout, 401, build mismatch, HMR, or reload. The default API deliberately has no generic retry option.

### Idempotency

The base protocol promises no exactly-once execution. Operations such as payment/order creation need an application-owned idempotency key in their typed input, transactionally scoped to principal, operation, resource and canonical payload, with persisted result and explicit expiry. Reusing a key with different data must fail.

PSX does not expose an `idempotencyKey` transport option until it includes a real compatible server policy/store. A header without server deduplication would be misleading.

## 14. Errors, redirects, and boundaries

### Three distinct error paths

1. **Expected server refusal:** validation, unauthenticated, forbidden, not found, conflict, payload limit, rate limit. Preserve HTTP status and return a public problem. Action calls resolve `{ok:false}`; query/loader APIs expose a typed failure/error state.
2. **Unexpected server or renderer failure:** log once with request/build/operation identity, return sanitized failure, reject the imperative operation with `RequestFailure`.
3. **Client render/runtime failure:** a real React boundary handles render failures. Event/action adapters handle their own rejected promises. The reporting callback receives only sanitized metadata by default.

`RequestFailure` exposes `kind`, safe `message`, optional `status`, `requestId`, and `outcome: 'not-sent' | 'rejected' | 'unknown'`. A dropped mutation response or malformed post-send response is conservatively `unknown`. A server 500 after action entry must not claim the database was rolled back.

### Boundary APIs

```ts
interface RouteErrorProps {
    problem: PublicProblem;
    retry(): Promise<void>; // repeats a safe read, never the failed mutation
}

interface RenderErrorProps {
    error: Error;
    reset(): void;
}
```

The export named `ErrorBoundary` is an application fallback component; PSX wraps it in a real class-based React error boundary. It does not pretend a function alone catches errors.

- Root boot/protocol failures have a dependency-light built-in error document/UI.
- Leaf loader failures can keep already authorized ancestor layouts from that same response. They must not reuse an ancestor that failed auth or belongs to another identity partition.
- If a parent loader fails, omit the failed and deeper data. Never briefly render stale protected content before the error/login UI.
- Render reset remounts the failed subtree. Loader retry revalidates. Neither replays a mutation.
- A global server error renderer must not run authenticated layout loaders or mutate sessions: the existing Crab renderer receives the original request after middleware processing.

### Redirects

- A document loader redirect is an ordinary HTTP redirect before any HTML body is sent.
- A navigation/query/action redirect is a typed protocol control response, not a fetch-followed login HTML document.
- Internal redirects must be same-origin relative targets. External redirects require the explicit external constructor and HTTP(S) allowlisting at the application boundary.
- Query auth failures normally expose a login target, not a silent navigation side effect.
- Action redirects are returned to the initiating caller. Follow them with a navigation-origin guard when appropriate.
- Preserve `Allow`, `WWW-Authenticate`, `Retry-After`, `Vary`, cache headers, and all cookies while formatting errors. Never replace the application's unrelated error format globally just because PSX is installed.

## 15. Serialization and type generation

### Supported wire values

| PHP declaration | Client representation |
| --- | --- |
| `string`, `bool` | `string`, `boolean` |
| Safe `int`, finite `float` | `number`, validated against JS-safe bounds |
| Nullable `?T` | `T | null`; does not mean optional |
| Backed enum | Literal union of its backing values |
| Explicit readonly DTO | Readonly object with declared public constructor properties |
| `array` with existing `#[ListOf(T::class)]`/supported type metadata | Readonly array of T |
| Explicit string-keyed map type | Readonly string-keyed record |
| `DateTimeImmutable` in supported input schema | Declared ISO string, never automatic JS Date revival |
| `void` result | Documented absent data normalized to `null` on the wire |

- Large IDs and precise monetary decimals use strings. Values outside the JS-safe integer range are rejected unless explicitly declared as decimal strings; never silently rounded.
- The schema determines `[]` versus `{}` for empty PHP arrays. Sparse lists, mixed-key arrays, unsupported map keys, cycles, resources, closures, and arbitrary object graphs fail validation.
- No generic `jsonSerialize()` traversal and no automatic ORM/entity serialization. Only declared output DTO fields are visible.
- Input defaults mean optional fields; nullable without a default remains required. Existing `Data::has()` semantics are preserved for partial updates.
- Ordinary JSON cannot carry `undefined`, NaN, Infinity, File, Map, Set, JS Date objects, or PHP instances with behavior. Encode explicit values.
- Dates are offset-bearing ISO strings with documented precision. Date-looking strings remain strings. Local calendar dates use a separate explicit string format rather than pretending they are instants.
- Generated output types come from native types, existing supported validation metadata, readonly DTO structure, and constrained wrapper generics. Dynamic arbitrary arrays fail at build time; do not infer output structure by executing PHP.
- No second application-maintained JSON schema or generated OpenAPI document. Protocol schema artifacts are internal compiler products from the declared types.
- Every server input is validated at runtime. Every output is checked before encoding. The browser validates protocol/build/schema and bounded payload shape before cache installation.
- Decoders do not merge arbitrary keys into prototypes. Dangerous keys are treated as data only through safe records or rejected where a DTO schema does not declare them.

Field errors reuse Crab's dotted paths such as `lines.0.quantity`. PSX DTO property/field names cannot contain dots or brackets; numeric segments are list indices. A generic map key requiring ambiguous dotted error addressing is returned as a whole-map error in protocol v1 rather than an invented ambiguous child path.

### Form encoding

`.form()` transmits actual multipart `FormData`; it does not flatten with `Object.fromEntries()`. Do not set a multipart boundary manually.

The supported schema-shaped name grammar is `title`, `address[city]`, `tags[]`, and `lines[0][quantity]`. Duplicate scalar leaves, mixed append/index addressing for one list, sparse indexes, invalid names, and keys that PHP would normalize ambiguously are rejected. Empty string, absent field and explicit JSON null remain distinct; forms cannot represent every JSON null operation, so nullable clearing uses an explicitly declared field convention or the typed JSON call, never a hidden global coercion.

Current Crab query/urlencoded parsing uses permissive `parse_str` and can truncate at `max_input_vars`. Therefore strict PSX decoding is an explicit core-integration requirement: bounded shared parsing must refuse truncation and ambiguous duplicates before the regular typed binder runs. This must not be claimed solved by generating TypeScript.

Queries use the same strict shape rules and bounded URL encoding. Files remain uploaded-file streams and are not representable in query strings.

## 16. HTTP protocol

Protocol name: `psx/1`. Request/response size limits apply before unbounded decoding.

### Request headers

```text
Accept: application/vnd.crab.psx+json
X-PSX-Protocol: 1
X-PSX-Build: <release-id>
X-PSX-Schema: <operation-or-route-schema-id>
```

Document requests use normal HTML negotiation. Generated fetches use same-origin credentials, **`redirect: 'error'`**, and no browser-accessible auth token. No protocol request follows an HTTP 302/303/307/308: a 307/308 must not replay a mutation body at a second endpoint. Only a validated PSX control envelope may instruct later navigation, never action resubmission. An unexpected post-send HTTP redirect is a transport failure with conservative mutation outcome. The protocol selector is not proof of origin or authorization.

- Read inputs are query parameters on generated GET routes.
- JSON actions send the typed body object directly, not a second arbitrary positional-arguments array.
- Form actions send multipart fields/files under the same typed body schema.
- Protocol metadata is in headers, not mixed into application fields.
- Unsupported media types receive 415; unsupported acceptable representations receive 406. Correctly handle media-range quality values, including `q=0`.
- Safe media selection adds `Vary: Accept`; add any other header that genuinely selects a cacheable representation. Private protocol responses are no-store regardless.
- Validate protocol/build/schema before **loader/action entry**. A rejected stale write has not entered the action; this does not claim arbitrary application middleware never ran.
- Success responses carry `X-PSX-Protocol`, `X-PSX-Build`, and `X-PSX-Schema` matching the envelope, request and declared success payload. CORS is not required for same-origin apps; an explicit cross-origin deployment must expose the needed headers under its own policy.

### Stable control/refusal layer

Protocol-v1 control envelopes are independent of release-specific DTO schemas. They carry `protocol`, `kind`, `respondingBuild`, `requestedBuild`, `execution: 'not-entered' | 'entered'`, and a bounded public problem or redirect target. On a response, parse only this small bounded discriminator/control schema first. A valid `build_mismatch` with `execution: 'not-entered'` is a known refusal even when `respondingBuild` differs; success data still requires exact matching build/schema before decoding or installation.

A protocol preflight/representation layer recognizes protocol headers on the application's request boundary before matched-handler dispatch. Thus an old removed operation URL receives a stable mismatch refusal when its requested build differs, and a stable 404/not-entered when the build matches but the route is absent. It adds no callable catch-all and never bypasses routing/auth. Missing/invalid protocol headers on generated operation paths receive a stable 400/406 refusal; arbitrary ordinary routes without PSX headers retain their existing behavior. Unsupported protocol versions return a bounded non-executing refusal; clients that cannot understand that version show a refresh/error, never retry a write.

The JSON snippets below omit those common response headers; their `build` field denotes the exact release for success payloads. Problem/redirect examples use the independent control shape.

### Page response (illustrative wire shape)

```json
{
  "protocol": 1,
  "build": "release-id",
  "kind": "page",
  "requestId": "request-id",
  "route": {"id": "posts.edit", "href": "/posts/42"},
  "nodes": [
    {"mount": "app", "module": "layout-id", "key": "app", "data": {}, "scope": {}},
    {"mount": "posts.edit", "module": "page-id", "key": "posts.edit:42", "data": {}, "scope": {}}
  ],
  "head": {"title": "Edit post"},
  "tags": ["posts", "post:42"]
}
```

Empty data/scope objects above stand for schema-defined values, not an unrestricted wire contract. The complete generated envelope schema validates each node and mount relationship. A response cannot cause the browser to import an arbitrary URL; module IDs resolve through the public build manifest.

### Action success

```json
{
  "protocol": 1,
  "build": "release-id",
  "kind": "action",
  "ok": true,
  "data": {"id": "42", "version": "8"},
  "invalidate": ["posts", "post:42"],
  "authChanged": false
}
```

Success is HTTP 200 with a JSON envelope, including void success (`data: null`). It is not sometimes 204 and sometimes a raw text response. Cookies remain HTTP headers.

### Expected failure

```json
{
  "protocol": 1,
  "kind": "problem",
  "respondingBuild": "release-id",
  "requestedBuild": "release-id",
  "execution": "not-entered",
  "problem": {
    "status": 422,
    "code": "validation",
    "message": "Check the highlighted fields.",
    "fields": {"title": ["Title is required."]},
    "query": {},
    "path": {},
    "requestId": "request-id"
  }
}
```

Status remains 422; the client does not turn every response into HTTP 200. Build incompatibility uses HTTP 409 and code `build_mismatch`, distinct from an application `conflict`. Protocol incompatibility is a client-visible non-retryable error, not an action retry.

Clients check status, content type, bounded body, the stable control discriminator, and then exact protocol/build/schema for release-specific data. A CDN HTML 413/502 page is a transport failure, not a JSON application problem. An unexpected redirect from custom middleware is rejected by fetch and never followed; the client cannot depend on seeing its Location header or treat login HTML as successful query data.

Execution provenance is not inferred from HTTP status. Preflight, typed input and auth refusals before the method are `not-entered`; application-returned failures after method entry are `entered`. Expected application failures assert the action's no-durable-write/rollback contract. An unexpected post-entry exception, malformed response, output serialization failure or lost connection is conservatively unknown for a mutation, regardless of its status.

Query success is HTTP 200 with `{protocol:1, build, kind:'query', data, tags}` and matching schema response headers. An expected query refusal uses the stable problem envelope and becomes `QueryProblem`; a query redirect is HTTP 200 with `{protocol:1, kind:'redirect', respondingBuild, requestedBuild, execution, target:{href,mode,replace}}` and becomes `QueryRedirect`, not query data or implicit navigation. Navigation loader redirects use that same control envelope; document loader redirects remain real HTTP redirects. Action success may include a typed `redirect` member inside its success envelope; an auth refusal remains a problem with an optional login URL.

Redirect control envelopes include a bounded target and internal/document disposition. Error formatting must also cover 404/405 and middleware rejections before a handler runs, using original request protocol headers and response-carried safe context rather than global state. Authorized partial ancestor chains are optional release-specific `pageError` context and are decoded only when their build/schema match; a mismatch refusal can never inject new-build layout data into an old runtime.

## 17. Authentication, authorization, and security

### Integration, not replacement

- Reuse Crab's explicit authentication middleware. PSX does not create another user model or serialize an Identity object into props.
- Reuse `CookieAuth` and its same-origin protections where enabled. The existing middleware must gain protocol-aware auth refusal handling; its current `login:` redirect ignores Accept.
- Public/session-only unsafe endpoints also require origin protection. `StartSession` alone is not CSRF protection. Extract/reuse a standalone origin-guard contract rather than assuming a token-auth middleware always runs.
- Compare origins using the configured public `app.url`, especially behind proxies/TLS termination. Never infer trust from an arbitrary forwarded header.
- Layout and page-family middleware must protect direct query/action requests. Run object/resource authorization inside application services/actions too.
- Check auth on every request; page props and branded scopes are not credentials.

### Client identity changes

A JavaScript epoch cannot control the order in which a browser applies Set-Cookie. The default integration therefore uses existing Crab login/logout document routes followed by full navigation. A current client notified through `app.authChanged()` clears protected state and enters a reconciliation barrier; it does not simply relabel cached data as belonging to a new user.

For **in-app** identity-changing actions, opt in explicitly with `#[Action(auth: true)]` and bind `Crab\Psx\Contracts\AuthState` through `psx.auth_state`. Its `snapshot(Request): AuthSnapshot` returns an opaque noncredential browser-context ID, monotonic decimal-string revision and opaque principal/cache partition. The application auth adapter must atomically compare the expected revision on transition, increment it with credential issuance/revocation, and reject obsolete credential revisions. This is an extension over the application's real auth store/middleware, not a new PSX user model; current unversioned CookieAuth alone does not fulfill it. Startup refuses generated auth-transition actions without that adapter. Ordinary protected pages need no such adapter.

Auth-transition state machine:

1. Capture local epoch and server auth revision on dispatch; permit one locally active auth-transition action. Other writes wait or receive an explicit auth-transition refusal, never an automatic retry.
2. A successful transition returns `authChanged` and its new AuthSnapshot. Before exposing protected data, increment the local epoch, invalidate all navigation transactions, clear private caches/drafts, and enter a barrier. Broadcast only an invalidation notice to other tabs.
3. Reconcile through a safe server document/data read under the browser's **current** credentials. Install only data carrying the authoritative partition/revision and the barrier's latest generation. An older response is discarded even if it completed last locally.
4. A stale, concurrent, lost or ambiguous auth response always forces reconciliation; ignoring its JSON cannot undo a Set-Cookie the browser applied. Obsolete credential revisions are refused server-side. If reconciliation cannot establish a current identity, use full document login/navigation, not stale protected UI.
5. The transition's own success may be shown locally, but its old `scope.navigation` cannot redirect after the epoch changed. The auth-marked action's successful `ActionResult.auth` (and the result of `app.authChanged()`) carries `{status:'reconciled', origin}` after successful reconciliation, or `{status:'document-required', origin:null}` when it cannot safely reconcile. Reconciliation is bounded; its failure does not turn a committed auth transition into a failed mutation. The application performs its chosen full document navigation when required. No old action obtains this new origin automatically.

`AuthState` snapshot data is included in authenticated bootstrap/protocol envelopes when this adapter is enabled; it is cache identity, never an authorization capability. Revision comparison is numeric decimal comparison, not lexical string ordering. Application middleware must enforce the server revision/CAS policy across tabs/processes; a client mutex alone is not sufficient.

Operations, visibility/bfcache recovery and explicit `app.authChanged()` notices discard stale private responses. Changes made outside the cooperating auth adapter cannot be magically observed instantly; such integrations force a document navigation or notify reconciliation. An old action uses current browser credentials when sent, but its result cannot populate another known epoch's cache or redirect its new page. The concurrent login/logout plus delayed Set-Cookie case is a required acceptance test, not an assumed property of the local epoch.

### Data and source confidentiality

- Every byte in loader props, query data, action results, head metadata, public manifests, and client schemas is visible to that browser. SSR does not make it secret.
- Do not expose an entire user/model object; project a minimal DTO.
- Default authenticated documents and all protocol responses to `Cache-Control: private, no-store`. CDN/Cloudflare rules must never override this for authenticated routes or cache protocol bodies as public HTML.
- Public immutable assets alone receive long immutable caching. Public page caching is an explicit separate policy with auth exclusion, cache keys, Vary behavior, and review; it is disabled by default.
- Escape bootstrap JSON so `<`/`</script>` cannot terminate its data script. No HTML interpolation of unescaped JSON.
- Generated HTML has a real CSP plan: external scripts, per-document nonce where needed, no production `unsafe-eval`, no blanket `unsafe-inline` requirement.
- Raw `.psx`, PHP, source snapshots, private manifests, SSR internals, credential files, and generated server artifacts stay outside the public tree. Deny raw/source query forms in Vite too.
- Source-map and dev-overlay tests scan for a sentinel PHP secret and private path. Full PSX source must never be a public `sourcesContent` entry.
- Bound action/query/body/output sizes, nesting, part counts, redirects, cache capacity, and concurrent renderer work. Enforce server-side limits independently of client hints.

## 18. Documents, metadata, CSS, and assets

### Document contract

`DocumentRenderer` receives an immutable prepared document: safe head values, validated page envelope, public asset references, rendering mode, optional SSR HTML, status, and request-local CSP nonce. It does not execute loaders, access a global user, or fetch services while emitting HTML.

The default renderer produces the minimal doctype, language, head, app root, non-executable bootstrap data, scripts, and no-JS message. An optional Arc adapter may render this shell from already prepared values. Arc is not a dependency for React rendering.

### Metadata

- Server `Head` values establish document status-dependent metadata before response flush.
- Merge outer-to-inner with explicit stable keys; nearest title/description/canonical wins. Remove route-specific tags on navigation.
- Meta/link constructors accept a bounded safe attribute set, not arbitrary raw HTML or script injection.
- Canonical/social URLs come from trusted application URL configuration, not untrusted Host headers.
- Runtime metadata updates and React's own metadata features need one owner per tag; the scaffold uses PSX Head for route metadata and documents conflicts rather than duplicating tags.
- Locale and text direction can be explicit document values; number/date formatting remains application code with an explicit locale/time zone. Locale route prefixes are ordinary declared routes.

### Assets and CSS

- Normal TSX imports, CSS imports, CSS modules, fonts, SVGs, and Vite public assets work under the same rules as ordinary React.
- No PSX scoped-CSS language, Tailwind requirement, or bundled design system.
- Page/layout chunks are code-split. Preload only required initial chunks; lazy client widgets remain ordinary React lazy/Suspense or `clientOnly`.
- Vite's explicitly public environment variables are visible to browsers. PHP secrets never become `import.meta.env` automatically.
- Assets use manifest URLs with a configured base. Route URL generation and asset URL generation are different responsibilities; subdirectory deployments must be tested.

## 19. Server rendering

SSR is a specified deployment mode, not a vague promise and not a requirement for every PSX app.

| Mode | First response | Browser | Production processes |
| --- | --- | --- | --- |
| `client` | Shell + authorized initial data | `createRoot` | PHP + static assets |
| `server` | React HTML + identical authorized data | `hydrateRoot` | PHP + static assets + JS renderer |

Both use the same page/load/query/action/navigation contract. Default mode is `client`; a page or app explicitly enables `server`. A site requiring initial content SEO must use SSR or a separately specified static-rendering product; CSR alone does not promise it.

### Renderer contract

- PHP resolves auth, guards, loader data, status, redirects, metadata, and asset/build identities before asking the JS renderer to render.
- The renderer receives only the validated public page envelope and known build/module IDs. No request object, database connection, cookie header, auth token, or PHP source is sent.
- The renderer executes only its locally installed release bundle. A request cannot provide a module path or script URL.
- Use a request-local router/query context with the exact initial snapshot. No mutable module-level current route or cross-request data cache.
- SSR performs no query/action RPC during render. Queries use loader-prepared initial data or a deterministic pending state.
- Preload the matched component modules. Buffer a bounded render until the required tree/head/status are known. Protocol v1 does not stream partially authorized loader data or offer deferred server-loader boundaries.
- Hydration uses the identical release, values, route/layout keys and locale/timezone decisions. No automatic duplicate loader fetch just because hydration starts.
- `clientOnly(() => import('./BrowserEditor'))` avoids evaluating a browser-only module on the server. It renders the identical fallback on SSR and the first hydration pass, then loads/mounts the widget after client commit. Merely wrapping already-imported code in a conditional is not sufficient.
- Bound queue length, request time, output bytes and process memory. Renderer failure is an actionable 503/500; default behavior is not silent CSR fallback.
- A renderer timeout does not rerun actions; rendering is only on the read/document path.

### Process and transport

The supported initial SSR transport is a private local Unix socket, mode 0600 and an owner accessible only to the application/renderer account. By default a foreground Node process is supervised through Crab's existing server mechanism. Its versioned bundle and protocol must match PHP. `psx.ssr.supervise=false` connects to an independently supervised **local** renderer using the same socket/release protocol. The private-socket connector is an explicit adapter to implement, not something already supplied by PSX.

Remote HTTP rendering and its credential/rotation protocol are outside this version; no dormant insecure remote-endpoint setting is accepted. Horizontal replicas can each run a local renderer. SSR endpoints are not browser API endpoints. Renderer logs include request/build IDs, never full props. Client-rendered deployments have no renderer process/socket settings to satisfy.

The server readiness barrier includes renderer readiness in SSR mode. Old/new PHP generations must talk to their matching renderer generation or reject safely; a single unversioned renderer address cannot silently switch bundles beneath old PHP workers.

## 20. Uploads, downloads, and background work

### Uploads

- Input DTOs use existing uploaded-file types and validation rules. A field is a file only when the schema declares it.
- Stream from Crab's bounded stored body/upload abstraction; never base64 encode files into JSON.
- Validate real content, aggregate/per-file size, count, storage ownership, and safe generated filenames. Client MIME and filenames are untrusted.
- Reject oversized requests at proxy/engine limits before application work where possible. Current Crab invokes middleware after receiving the full request body, so origin/auth middleware cannot promise to prevent all upload reception cost.
- Clean temporary files on rejection, cancellation and success according to ownership transfer. Jobs must receive durable storage IDs, not temporary request file paths.
- Browser fetch does not provide portable byte upload progress. Do not expose a fake progress percentage. An optional XHR transport can implement the same protocol; resumable/direct-to-storage upload is a separate explicitly authorized flow.
- A canceled upload/action may have an unknown server outcome. Never automatically resend it.

### Downloads and streaming

Return a typed authorized URL or resource identifier from an action/query, then use an ordinary guarded Crab download route. Downloads may stream and set Content-Disposition; they do not pass through the JSON action envelope.

SSE/WebSockets remain ordinary Crab routes with explicit authentication. A JS client can use them to call query invalidation or safe navigation revalidation. PSX does not create a second socket server or automatic subscriptions for every loader.

### Long-running jobs

An action starts work through the existing queue and promptly returns a typed job ID. A query reports status; polling or an explicit real-time route updates the UI. Queue-after-write semantics must use Crab's existing after-commit/transactional queue pattern. An HTTP action is not a durable background job.

## 21. Compiler, editor, and developer workflow

### Build pipeline

1. Enter CLI-only **collection mode** before loading a selected release. Install an open source-declaration registry, run trusted application/plugin/setup/route declarations, and collect source paths, roles, mounts, middleware and cross-route names without resolving generated Server classes. A prior manifest is not required.
2. Parse PHP/TSX into separate representations with source positions.
3. Validate module shape, role, service dependencies, typed input/output projection, generated bindings and layout mounts.
4. Generate PHP definitions and a private manifest without running loader/action code.
5. Generate stripped TSX virtual modules and explicit type modules.
6. Boot a **fresh validation definition process** against the staged candidate manifest, after all declarations. Resolve signatures/composite projections, check dependencies and all ordinary-route collisions, and typecheck/lint PHP and TSX. Then let Vite build client and optional SSR graphs.
7. Verify public outputs contain no PHP source/sentinel secrets/private files.
8. Publish one immutable release directory and matching manifests atomically. Normal serve mode requires this complete selected release and verifies source declarations against it.

Collection executes the application's trusted registration code, not loader data. It defers generated-service construction/signature checks until staged validation; ordinary declaration errors can still fail early. The command launcher selects collection mode for `psx:init/check/types/build` before plugin serving validation; it is a trusted CLI execution context, never a request header or a production fallback for a missing manifest. Production serving refuses collection mode. `psx:init` needs only configuration/registration scaffolding, while check/types compile enough staged metadata for full signature checks without requiring old artifacts. This needs the core lifecycle integration described in section 25; the existing bootstrap cannot simply be assumed to support it.

The compiler does not execute loaders or infer output structure by running PHP methods. Definitions that do I/O remain invalid under Crab's existing rules.

### CLI

| Command | Contract |
| --- | --- |
| `php cua psx:init` | Explicit scaffold, no silent overwrites |
| `php cua psx:check` | Source/registration/type/build-compatibility checks; nonzero on any error |
| `php cua psx:build` | One coordinated PHP/types/client/optional SSR production build |
| `php cua psx:list` | Page families, layout chain, operation routes, roles, sources, guard chains |
| `php cua psx:types` | Generate/check editor and CI type views without a production build |
| `php cua dev` | One development supervisor for PHP, compiler and Vite |

`psx:build` delegates JS compilation to the installed npm package using the project lockfile toolchain. It never installs dependencies implicitly. Normal CI can run PHP and JS checks independently; neither depends on an editor extension.

### Vite configuration

```ts
import { defineConfig } from 'vite';
import { psx } from '@crabphp/psx/vite';

export default defineConfig({ plugins: [psx()] });
```

`psx()` integrates the normal React transform/Fast Refresh and consumes the staged manifest path supplied by the build/dev coordinator, including generated type aliases and the shared wrapper. It does not discover server routes from filesystem conventions. Running Vite alone without prepared metadata fails with the command to run; it never invents an empty backend. React refresh is configured once, not by stacking a second duplicate React plugin.

### Development behavior

- PHP or server-schema edits require a fresh PHP generation after successful compilation. PHP definitions cannot be safely patched into long-lived workers.
- TSX-only compatible edits use React Fast Refresh. CSS uses normal Vite HMR.
- A schema/export/route change rebuilds both sides and refreshes the affected client safely. No mutation is replayed.
- Publish matching artifacts before switching workers. If compilation fails, keep the last good generation and show a sanitized diagnostic; never serve half a new release.
- Add/edit/delete `.psx` and dependencies are watched. Watching only `.php` is insufficient; this is a known framework gap.
- Exclude generated build directories from source watchers to prevent restart loops.
- Vite is development-only. Register it with `Servers::process` only under the explicit dev launcher/configuration, never unconditionally in production.
- Initial startup has a compiler/Vite readiness barrier. Merely launching two processes at once is not sufficient.
- Bind dev services locally by default. Remote preview requires an explicit origin/host allowlist; never expose unrestricted raw Vite filesystem access.

### Editor and diagnostics

- One source file produces mapped PHP and TSX virtual documents. PHP completion/typechecking and TypeScript/React diagnostics retain original line/column positions.
- Rename/find-references links a PHP exposed method to its generated `$method` uses. Unknown generated names fail CLI checks too.
- Formatting operates on each region with stable delimiters; no formatter sends PHP through a TS parser or vice versa.
- Browser source maps refer to stripped TSX virtual sources only. Private full mappings support PHP diagnostics and build tooling.
- Dev overlays never show the PHP preamble or server secret values in browser snippets.
- Client stack traces include release/module identity. Server logs can map generated PHP frames to private source locations without exposing call arguments.

## 22. Builds, deployments, and compatibility

A release is a matched tuple: PHP definitions, route/schema manifest, public JS/CSS, generated types, optional SSR bundle, and protocol/build ID. Production artifacts are immutable.

### Build/deploy sequence

```text
install locked dependencies
    → check PHP/TSX and declarations
    → build all matching artifacts in a new directory
    → run protocol/security/browser acceptance tests
    → deploy release + retain older hashed public assets
    → run backward-compatible migrations
    → start matching SSR generation if enabled
    → atomically select release and reload Crab
    → readiness passes, then drain old generation
```

A failed build/reload leaves the previous working release intact. Application source need not be writable by production workers. Build artifacts needed to boot are not stored in the runtime-only storage directory.

### Old tabs and rolling generations

- Requests carry build/schema identity. An incompatible write is rejected before action invocation with `build_mismatch`.
- Default compatibility policy is exact release match. A newer server does not pretend an old operation is safe because its method name still exists.
- Old and new generations may overlap while draining. A request reaching a nonmatching generation may receive a safe incompatibility refusal; this is preferable to executing against the wrong schema. Deployments needing zero transient read mismatch can use release-aware routing or a deliberately supported compatibility window.
- Retain old hashed public assets for a bounded deployment window so already loaded pages do not instantly lose chunks.
- Never reload/resubmit a mutation automatically. Show a refresh/reconciliation choice; preserve in-memory drafts until the user chooses. Persistent draft storage is opt-in and must exclude sensitive fields.
- A read-navigation chunk failure may offer one controlled document reload, guarded against a loop and subject to dirty-navigation confirmation.
- Rollbacks require database compatibility and matching manifests too. Static asset retention alone does not make old PHP compatible with new schemas.
- Service workers, if an application adds one, must obey release identity and never cache private PSX responses by default.

## 23. Configuration and limits

Every setting has a schema and startup validation. Unknown settings fail. Proposed defaults are engineering starting points to be measured, not unchangeable guarantees.

| Setting | Proposed default | Notes |
| --- | --- | --- |
| `psx.resources` | `resources` | Private source root |
| `psx.build` | `build/psx/current` | Selected immutable private release |
| `psx.assets` | `/assets/psx/` | Public URL base, not source path |
| `psx.entry` | `resources/entry.tsx` | Explicit browser entry |
| `psx.wrapper` | `null` | Optional shared provider-component module, browser and SSR |
| `psx.auth_state` | `null` | AuthState adapter class; required only for `Action(auth: true)` |
| `psx.rendering` | `client` | `client` or `server` |
| `psx.max_response_bytes` | 2 MiB | Encoded page/query/action data; excludes static assets |
| `psx.max_depth` | 32 | Input/output structured data |
| `psx.max_collection_items` | 10,000 | Additional shape bounds; engine/body limits still apply |
| `psx.max_input_nodes` | 20,000 | Aggregate decoded input nodes across nested values |
| `psx.max_field_name_bytes` | 256 | Strict form/query field name limit |
| `psx.auth_reconcile_seconds` | 5 | Bounded barrier read; on failure require document navigation |
| `psx.query_cache_entries` | 200 | Per browser app/auth partition |
| `psx.query_cache_bytes` | 8 MiB | Approximate encoded-size accounting, with eviction |
| `psx.query_cache_gc_seconds` | 300 | Unused entries |
| `psx.prefetch_ttl_seconds` | 15 | Optional intent prefetch only |
| `psx.read_retries` | 0 | At most 2 when explicitly configured |
| `psx.ssr.supervise` | `true` | Start local renderer with Crab; false connects to an independently supervised local renderer |
| `psx.ssr.socket` | `storage/psx/ssr-{build}.sock` | Private Unix socket; resolved per immutable release |
| `psx.ssr.node` | `node` | Trusted executable, resolved at startup |
| `psx.ssr.memory_mb` | 256 | Renderer process heap budget, positive integer |
| `psx.ssr.max_request_bytes` | 3 MiB | Complete bounded renderer IPC envelope, not only props |
| `psx.ssr.timeout_seconds` | 5 | Includes queue/connect/render; fits within HTTP response deadline |
| `psx.ssr.max_html_bytes` | 4 MiB | Bounded buffered HTML |
| `psx.ssr.max_inflight` | 16 | Per renderer; reject/queue only within a bounded policy |
| `psx.ssr.max_queue` | 32 | Queue wait included in deadline |

Request body, file count/bytes, header, URL, connection, and upload limits remain subject to Crab/proxy limits. An operation input schema may impose tighter limits; PSX cannot silently raise the engine's limits. Browser action timeout/cancellation semantics must distinguish unknown outcomes rather than imply rollback.

SSR socket ownership/path, supervision mode, executable, memory/request/HTML budgets and deadlines are validated together when SSR is enabled. The socket must be outside public paths, cannot be a symlink to an untrusted socket, and is qualified by the immutable release. The renderer validates a bounded release/protocol handshake before accepting work. Independent supervision still requires readiness and matching release; `supervise=false` is not permission to skip them.

Resolve `psx.build` (including a `current` symlink) to a real immutable release directory and manifest hash **once per PHP generation**. Requests never reread a moving symlink. A missing release is allowed only in the explicit CLI collection mode, not serve mode.

Development mode is a trusted command execution context supplied by `php cua dev`, not `app.debug`, a request header, or a production environment guess. It alone enables compiler/Vite supervision and staged manifests. `start`/daemon serving never launches Vite; `psx:build` uses its own explicit build context. This command-context plumbing is part of the required lifecycle integration.

Limit owners: proxy/engine own received bytes, header/URL/body deadlines and total HTTP body storage; strict HTTP decoding owns field names, duplicates, depth and aggregate input nodes before conversion; input/output schemas own tighter field/list bounds; WireCodec owns encoded response bytes; SSR transport owns complete IPC bytes, queue/inflight limits and an end-to-end deadline; Node supervision owns memory. Exceeding request bounds returns 413 before action entry where detectable; exceeding output/SSR budgets is a logged server failure, conservatively unknown if an action already ran. Configuration checks reject contradictory budgets rather than silently raising an underlying Crab limit.

Production refuses a missing release, mismatched asset manifest, public source directory, missing optional renderer in SSR mode, or incompatible runtime versions.

## 24. Testing and observability

### PHP tests

Expose a `PsxTest` helper over the existing application's request handling, not a mock dispatcher that bypasses middleware. It can request a document/navigation envelope, invoke a generated query/action by public declaration, and inspect typed outcome/headers.

Test module/service logic directly as ordinary PHP with fake dependencies. Test protocol through `$app->handle(...)`; use real worker tests for overlapping users, resource lifecycle and reload behavior.

### Client tests

`@crabphp/psx/testing` creates an isolated app/runtime with a protocol fixture transport. Fixtures validate the same envelope schemas as production. A mock cannot return fields a real server could not serialize.

Use React tests for drafts, action-state and error boundaries; browser tests for links/history/scroll/focus, multipart requests, reloads, deployment mismatch and SSR hydration. Test development compilation and public-artifact leakage, not only minified production JS.

### Signals and logging

Record request ID, release, route/module/operation ID, status, duration, response bytes, validation outcome, query/loader timing and SSR timing. Do not log credentials, full props, form bodies, SQL bindings, source secrets, or exception call arguments.

Expected 401/403/404/409/422/429 and user cancellation are normal outcomes/metrics, not error-tracker incidents. Unexpected PHP/SSR/compiler/protocol failures and genuine client bugs are actionable errors. Report each owned failure once; do not duplicate the same server exception in multiple middleware layers.

The browser reporting callback receives sanitized request/build identity for correlation. A network outage can be shown locally without automatically turning every failed fetch into an application exception incident.

`php cua describe` must include PSX declarations and dependencies. `psx:list` adds source locations, role, layouts, guard chains, generated endpoint names and wire schemas. Private implementation bodies are not emitted to browsers or introspection endpoints.

## 25. Required CrabPHP integration changes

These gaps were found in current source. They are prerequisites, not features PSX can truthfully claim to reuse unchanged.

### A. Prepared action invocation

Current `Routing\ActionHandler` combines input binding, callable resolution, execution and conversion to a response, behind a concrete class. Layout orchestration needs the raw result with existing validation semantics.

Proposed core contract:

```php
interface Actions
{
    public function prepare(string $method, string $pattern, Closure|string|array $action): PreparedAction;
}

interface PreparedAction
{
    public function invoke(Request $request, ?InputProjection $projection = null): ActionOutcome;
    public function signature(): ReflectionFunctionAbstract;
    public function input(): array;
    public function dependencies(): array;
}
```

`ActionOutcome` is a discriminated immutable value: either a raw successful return or a returned rejection response, never ambiguous `null`. The existing router must use this same implementation. PSX must not copy its own argument-source rules or call the internal concrete handler from a package.

`InputProjection` is an immutable server-created binding plan prepared at definition time for composite loader queries; it selects this invocation's declared fields from the strictly decoded/validated composite without modifying the full Request. It is not browser-supplied data and cannot bypass type/rule validation. The binder owns this behavior so PSX does not recreate its source classification.

Prepared metadata is process scope; resolved callable/services are worker scope; invocation arguments/results remain request-local. Signatures/dependencies are inspected before serving.

### B. Declaration validation and diagnostics

Add a general contract for package registries to contribute definition validation, dependency entries with source locations, and `describe` output before startup. Run finalization after plugins, application setup and ordinary route files, never inside PsxPlugin::register. Make the CLI collection/staged-validation/serve context available before selected-release validation. It must not be a new arbitrary side-effectful boot phase.

The current hardcoded `App::unmade()` traversal cannot see hidden layout registries. Either every dependency is represented in generated normal route constructors, or this contribution contract is required. We choose the contract so page/layout/shared modules remain explicit and inspectable.

### C. Representation-aware errors and auth refusals

- Provide a composable representation/error formatting mechanism selected from the original request and safe response-carried context. It must coexist with an application's custom ErrorRenderer.
- Provide/approve a contract factory for marked errors instead of depending on internal concrete response classes.
- Make auth refusal representation-aware: document GET can redirect to login; PSX navigation/query receives an auth problem/control envelope, not fetch-followed HTML.
- Preserve all middleware headers/cookies and avoid authenticated layout loading after error/session processing.
- Extract reusable unsafe-request origin checking for non-token-auth endpoints. Do not assume every mutation uses CookieAuth.

### D. Strict request decoding

Add a decode-policy selection step on the immutable request **before application middleware can trigger lazy parsing**. It selects PSX strict mode from the sealed path map and/or protocol selector, without executing a route. Parsing remains lazy, bounded and single-pass under the central HTTP error boundary; middleware asking for query/body data gets this same strict parse. Later installing a cleaned array is insufficient because original duplicate/name information would already be lost.

Strict query/multipart decoding preserves original names/counts until ambiguity checks complete, rejects truncation/duplicate scalar fields, and retains the existing upload storage bounds. Strict JSON requires a UTF-8 root object, rejects duplicate member names at every depth before associative conversion, and preserves schema-relevant object/list identity. `[]`, `null` or a scalar cannot become an empty all-default input DTO. Unsupported media/charset is 415, malformed/ambiguous structure is 400, exceeded bounds are 413, and structurally valid but schema-invalid input is 422.

Middleware cannot bypass this policy by parsing raw strings itself and expect PSX guarantees. Normal non-PSX routes retain their existing parser policy; do not silently change all Crab routes in a patch release. The shared parser/binder owns this work, not a second PSX-only unbounded decoder.

### E. Development readiness and watching

Extend watched source/dependency configuration beyond the current default `.php` extension and add a compile-before-generation-readiness barrier. Atomic PHP/JS artifact switching is required; `Servers::process('vite', ...)` alone is insufficient.

### F. Contract ownership

PSX-only contracts stay in `Crab\Psx\Contracts`: Pages/declarations, manifests, wire codec, document renderer, renderer transport, compiler/type projection and test transport. Only contracts used by the framework's own invocation/error/startup/development machinery belong in `Crab\Contracts`.

No engine layer depends on PSX, React, Vite, Node or application classes. Optional Arc integration stays behind DocumentRenderer. Add layer-boundary tests for every new deliberate dependency.

## 26. Production acceptance gates

The package is not production-ready merely because the happy-path post form works. Each item below needs an automated proof or an explicitly documented unsupported capability.

### Language/compiler

- PHP strings/comments/heredocs and TSX generics/comments survive splitting and mapping.
- Two pages with local Server/DTO/helper names do not collide.
- Missing/invalid schemas, illegal top-level effects, unknown `$operation` bindings, and generated-name conflicts fail with source locations.
- Server source never appears in client bundles, source maps, HMR, overlays, raw imports, public manifests or preview output.
- Editor and CLI see the same generated types; no `any` escape hatch hides unsupported outputs.

### Routing/layout/data

- Document, navigation, direct query and direct action use the correct guard chains, including configured middleware instances.
- Nested layouts load in order; redirects/failures stop child work and omit protected payloads.
- Layout state survives sibling navigation but remounts across tenant identity.
- Two instances of a reusable component query/save separate resources correctly.
- Disabled/deduplicated/background queries, stale responses and cache eviction preserve the documented state.
- Auth change discards old data and prevents old request completions from populating the new partition.

### React/navigation/forms

- Native anchor behavior, hashes, unknown history entries, Back/Forward, scroll/focus and dirty blocking work.
- Navigation A cannot commit after newer B; revalidation cannot overwrite another route.
- Save A finishing after navigation B cannot reset/redirect B.
- `useActionState` receives `(previous, payload)` correctly; controlled drafts survive expected failures.
- Enter key submission, submitter values, repeated lists, nullable/absent fields, and files have exact supported semantics.
- Overlapping edits conflict atomically rather than silently losing writes.

### Security/errors/protocol

- All statuses 400/401/403/404/405/406/409/413/415/422/429/500/503 have deliberate document/protocol behavior.
- Missing/forged operation IDs, wrong mount scopes, stale builds and invalid schemas cannot enter user action code.
- CSRF/origin protection covers public login and session-only mutations as well as authenticated actions.
- CDN/proxy non-JSON errors and redirect-to-login mistakes do not look like success.
- Interleaved requests from different users/sessions cannot leak state.
- Lost responses and post-commit failures remain unknown outcomes; no automatic mutation retries.
- Bootstrap/script escaping, unsafe URL targets, prototype keys, rich objects and unsafe integers are tested adversarially.

### Operations/deployment

- One dev command handles initial compilation and `.psx` add/edit/delete without restart loops.
- Failed build keeps the last good app; successful build publishes matching artifacts.
- Old tabs, retained assets, rolling reload, renderer generation mismatch and rollback are tested.
- SSR is request-isolated, bounded and hydration-stable; browser-only modules use explicit lazy boundaries.
- Upload limits/cleanup and malformed/interrupted uploads work under both app and proxy failures.
- Existing custom error rendering, normal JSON routes, Arc pages and PSX routes can coexist.
- Performance and memory budgets are measured against ordinary Crab routes; no unbounded cache/renderer queue is accepted.

## 27. Delivery order and decisions

This is a full product design, not permission to release an incomplete prototype as production-ready. Build in reviewable layers without shrinking the final contract:

1. Agree language/API and wire schemas; executable examples and negative fixtures first.
2. Add the minimal core invocation/error/definition/watch contracts with regression tests for ordinary Crab applications.
3. Build compiler/type projection and prove source separation.
4. Implement page/layout/service registry and document/navigation protocol.
5. Implement React router, immutable scopes, query cache and generated operations.
6. Complete forms, auth changes, uploads, concurrency/error/reload behavior and developer tooling.
7. Implement/test optional SSR mode, release tooling, security scans and interoperability.
8. Run the complete production acceptance matrix, document supported limits, pin versions, then release.

### Proposed decisions made by this document

- PHP functions with `#[Inject]` services, from which the compiler makes the class the router calls; real TSX below. (A hand-written class with constructor injection until 2026-11-18.)
- Explicit route registration and action/query exposure; `$` is a generated lexical binding convention.
- Loader, query and action are different operations.
- Scoped operations require explicit immutable `.at(scope)`; no mutable ambient route lookup.
- React's own form/action/state hooks, with honest adapters and controlled draft examples; no parallel form state framework in the core package.
- Strict declared wire types and constrained PHPDoc generics where PHP cannot express them.
- Ordinary Crab route families and middleware, not a bypass dispatcher.
- CSR and optional SSR are distinct supported deployment modes; no RSC/Flight claim.
- Versioned build/schema protocol and no automatic mutation retry.
- Native no-JS mutation forms, RSC, deferred loader streaming, persistent offline caches, resumable uploads and an automatic entity ORM/cache are outside this release's contract.

### Decisions still needing owner approval

The product direction and `$` visibility preference are confirmed; the detailed API is not yet approved. In particular: class-shaped PHP surface, exact names/package layout, `.at(scope)` ergonomics, explicit route registration surface, optional SSR scope, and required framework contract changes. The design recommends one coherent choice for each rather than leaving implementation to guess.

None of these open approvals changes the security/lifecycle facts: request state cannot be shared, auth cannot be inferred from a UI import, server code cannot ship in maps, and uncertain writes cannot be replayed blindly.

## 28. Source review

Read against `/home/daudau/Code/crabphp/framework` and its optional Arc package on 2026-11-15. Key references:

- `framework/AGENTS.md`, `ARCHITECTURE.md`, `COMPONENTS.md`.
- `src/Contracts/Routing/{Router,DeclaredRoute,RouteGroup}.php`.
- `src/Routing/ActionHandler.php` and `Router.php`.
- `src/Contracts/Http/{ErrorRenderer,Problem}.php` and the application error path.
- `src/Auth/CookieAuth.php`, auth/session guides and request lifecycle.
- `src/Contracts/Servers.php`, plugin/development guides and watcher implementation.
- `src/Http/Request.php`, multipart handling and validation documentation.
- Independent Astra 6 reviews: [server](reviews/server.md), [client](reviews/client.md).

The reviews are design research. No PSX implementation exists in these files, and no production test suite has been run for PSX. Existing framework behavior was inspected; proposed APIs and guarantees must be implemented and verified before release.
