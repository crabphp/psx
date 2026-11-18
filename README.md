# PSX for Crab

A page is one `.psx` file: a PHP `Server` class in a `<script lang="php">` block on top, a React component below. The compiler splits it. The PHP stays on the server; the browser gets the TSX and typed bindings to call the PHP.

```psx
<script lang="php">
use App\Http\PostDetail;
use App\Http\SavePost;
use App\Posts;
use Crab\Psx\Action;
use Crab\Psx\ActionResult;
use Crab\Psx\Failure;
use Crab\Psx\PageData;

final readonly class Server
{
    public function __construct(private Posts $posts) {}

    /** @return PageData<PostDetail>|Failure */
    public function load(int $id): PageData|Failure
    {
        $post = $this->posts->find($id);
        return $post === null ? Failure::notFound() : PageData::of($post)->tags("post:{$id}");
    }

    /** @return ActionResult<PostDetail> */
    #[Action]
    public function savePost(int $id, SavePost $input): ActionResult
    {
        $saved = $this->posts->save($id, $input);
        return $saved === null
            ? ActionResult::fail(Failure::conflict())
            : ActionResult::ok($saved)->invalidate("post:{$id}");
    }
}
</script>
import type { Props } from '@psx/types/pages/Posts/Edit';

export default function Edit({ data, scope }: Props) {
    const save = $savePost.at(scope);
    // data is typed from PostDetail; save takes SavePost's fields and gives an ActionResult.
}
```

This repository holds both halves: the Composer package `crabphp/psx` (here) and the npm package `@crabphp/psx` (in [`js/`](js)). A runnable application is in `../psx-demo`.

**Status: 0.1.0, the first release, not production-ready.** [docs/STATUS.md](docs/STATUS.md) says what is implemented, what is tested and what is not; read it before relying on anything. The design this implements is [docs/DESIGN.md](docs/DESIGN.md).

## Requirements

PHP 8.4, Crab 0.7.5 or later, Node 24, React 19.2, TypeScript 7, Vite 8. Linux or macOS: a generated file name holds a `?`, which Windows does not allow.

## Install

```sh
composer require crabphp/psx
npm install react react-dom @crabphp/psx
npm install --save-dev typescript vite @types/react @types/react-dom
```

```php
// app.php
use Crab\Psx\PsxPlugin;

return App::configure(__DIR__)
    ->withPlugins([new PsxPlugin(routes: ['routes/pages.php'])])
    ->withRouting(routes: 'routes/web.php')
    ->create();
```

```sh
php cua psx:init      # a first page, a layout, vite.config.ts, tsconfig.json; keeps files that exist
php cua dev           # the server, the compiler and Vite together
```

Keep `.psx/`, `build/`, `node_modules/` and `public/assets/psx/` out of version control.

## Declaring pages

Nothing is found by its place in a folder. `routes/pages.php` declares every page, layout and service:

```php
use Crab\Auth\CookieAuth;
use Crab\Psx\Contracts\Pages;

return static function (Pages $pages): void {
    $pages->layout('app', 'resources/layouts/App.psx');

    $pages->page('/login', 'resources/pages/Login.psx')->name('login');

    $pages->middleware(CookieAuth::class)->group(static function (Pages $pages): void {
        $pages->page('/posts/{id}', 'resources/pages/Posts/Edit.psx')->name('posts.edit')->layout('app');
        $pages->service('/finder', 'resources/components/PostFinder.psx')->name('finder');
    });
};
```

A page is a family of ordinary Crab routes: the document and navigation route, and one route for each query and action. Group, layout and page middleware guard all of them, in that order; `->operation('savePost', $guard)` adds a guard to one. `php cua psx:list` prints each page with its layouts, guards and addresses.

Crab answers a path with the first route declared that fits it. A query or an action whose address a route declared before it could take, the page's own path or an ordinary route such as `Route::get('/{any:.*}', ...)`, is refused when the application is compiled or defined, unless the two patterns are seen to be apart. A parameter is seen to stop at a `/` when it has no expression, or one of letters, digits, `_`, `.`, `-`, `\d`, `\w` and classes of those: `{slug:[a-z0-9-]+}` is, `{rest:.+}` and `{name:[^/]+}` are not.

### Or beside your routes, with short names

`Psx::` declares the same things from `routes/web.php`, next to `Route::`. A file can be named by its path, or by its name inside the folder of its kind under `psx.resources`: `pages/` for a page, `layouts/` for a layout, `components/` for a service.

```php
use Crab\Psx\Psx;
use Crab\Route;

Route::post('/logout', Logout::class);

Psx::layout('app', 'App');                                   // resources/layouts/App.psx
Psx::page('/counter', 'Counter')->name('counter');           // resources/pages/Counter.psx
Psx::middleware(CookieAuth::class)->group(function (): void {
    Psx::page('/posts/{id}', 'Posts/Edit')->name('posts.edit')->layout('app');
    Psx::service('/finder', 'PostFinder')->name('finder');   // resources/components/PostFinder.psx
});
```

Short names work in `routes/pages.php` too: `$pages->page('/', 'Home')`. With `new PsxPlugin()` and no `routes:`, `routes/pages.php` is read when it exists and is optional. All PSX routes are added after the application's own whichever file declares them, so the reachability check above is the same.

### An action anyone may call

`CookieAuth` refuses a `POST` from another site before it reads the cookie, so every action behind it is guarded. An action of a page with no login is not: PSX adds no guard of its own, and the protocol headers are not one. Where such an action changes something, or the application keeps its own session cookie, name the guard:

```php
use Crab\Http\SameOrigin;

$pages->page('/contact', 'resources/pages/Contact.psx')
    ->name('contact')
    ->operation('send', SameOrigin::class);
```

`SameOrigin` lets a request through when the browser says `Sec-Fetch-Site: same-origin` or its `Origin` is the application's (`app.url`, or the address the request reached). Any other `POST`, also one with no `Origin`, is answered 403 with `execution: not-entered`. Behind a proxy give it the public address: `new SameOrigin('https://shop.example')`. On a group it guards every action of the group; reads pass.

## The server half

The PHP block, `<script lang="php">` at the very start of the file up to its `</script>`, may hold imports, constants, functions, classes, enums and one `final readonly class Server`. The Server's constructor takes services. Its methods take what a Crab action takes: path parameters, an input class, `#[FromQuery]` fields, the user.

The end of the block is found by PHP's own lexer, so a `</script>` in a string, a comment or a heredoc does not end it; a `?>` inside it is refused. The `</script>` ends its line, and the TSX starts on the next. A file in the earlier `<?php` … `?>` form is refused with how to rewrite it.

| Method | Called | Returns |
| --- | --- | --- |
| `load()` | For the document, a navigation and a revalidation | A DTO, or `PageData::of($dto)->head(...)->tags(...)`; a `Failure` or a `Redirect` |
| A method with `#[Query]` | `GET`, by `$name.at(scope)(input)` or `useQuery` | A DTO, or `QueryData::of($dto)->tags(...)` |
| A method with `#[Action]` | `POST`, by `$name.at(scope)(input)` or `.form(formData)` | A DTO, or `ActionResult::ok($dto)->invalidate(...)->redirect(...)`; `ActionResult::fail(Failure)` |

Any other public method is a compile error. What a method returns is a `final readonly` class with typed public properties, a backed enum, a scalar, a date, or a list or map declared with `#[ListOf]` or `#[MapOf]`. `mixed` and an untyped `array` are refused: the TypeScript types are generated from these declarations, and the server checks every value against them before sending it.

What a request brings is read strictly on every PSX route, and refused before the method is called. What cannot be read one way only is a 400: JSON that does not parse, a body that is not an object, a field given twice, a list both appended to and indexed, a list with a gap, a field name that is not one. What reads but does not fit is a 422 with the fields named: a value of the wrong type, an object where a list is declared or the reverse, a case an enum does not have, and an integer outside ±9007199254740991 (in JSON, a form, the query or the path, and as an enum's value). A field the input does not declare is ignored, as Crab's binder ignores it. An integer-backed enum with a case outside that range does not compile. Ordinary routes of the same application read as they always did.

A request that speaks the protocol is checked for its protocol and build before it is routed, so a tab of an older release is answered 409 by any address, also one that is no longer a route, and before any guard. A document request that does not accept HTML is answered 406.

`Failure` is an expected outcome with a status: `validation(['title' => 'is taken'])`, `conflict()`, `forbidden()`, `notFound()`, `domain($code, $message)`. An exception is a 500.

## The browser half

Below the `</script>` is TSX, not wrapped in a block of its own; any PHP there (`<?php`, `<?=`, or another `<script lang="php">`) is refused, since the browser is given all of it. Each `#[Query]` and `#[Action]` of the file's own `Server` is in scope as `$name`.

```tsx
import { Link, useQuery, useRouter, RequestFailure } from '@crabphp/psx';
import { routes } from '@psx/routes';
import type { Props } from '@psx/types/pages/Posts/Edit';

export default function Edit({ data, scope }: Props) {
    const save = $savePost.at(scope);

    async function submit() {
        try {
            const result = await save({ title, version: data.version });
            if (!result.ok) {
                // result.problem: status, code, message, fields
            }
        } catch (error) {
            if (error instanceof RequestFailure && error.outcome === 'unknown') {
                // The answer was lost: it may or may not have been saved. Nothing is sent again.
            }
        }
    }

    return <Link href={routes.posts.edit({ id: 7 })}>Post 7</Link>;
}
```

- **`scope`** says which page a call is for. It is frozen. A save bound on post A's page saves post A, also when it is called after the browser has moved to post B.
- **Expected failures are results**, `{ ok: false, problem }`: a refusal before the method, or a `Failure` it returned. A lost answer, a proxy's error page, an answer of the wrong shape, and any failure the server did not write on purpose (an exception, a middleware answering after the method), whatever its status, is a thrown `RequestFailure`; for a query and a navigation too. A mutation is never retried.
- **One call is not one delivery.** PSX sends a write once and never again, but it does not own the connection: a browser may itself send a `POST` again when a connection it was reusing dies before any byte of the answer (Chromium was seen to deliver one write twice, and three times, that way), and a proxy may do the same. Nothing in the page can see or prevent that. An operation that must happen once, a payment or an order, takes an idempotency key in its own input and keeps it in the same transaction as the write; PSX has no such option of its own, because a header without a store behind it would promise what it cannot keep.
- **`#[Action(auth: true)]`** changes who is signed in. Its refusal is trusted only when the server says with it that who is signed in is still who the page knows: PSX says so for a `Failure` the method returned and for input that did not bind. After any other refusal, a guard's 401 or 403 among them, the page is closed and loaded again as whoever the browser is now; the refusal is still returned, and nothing is sent again.
- **Forms** use React's own `<form action={...}>` and `useActionState`. `.form(formData)` sends a form as a form; an action that takes a file is called this way only.
- **`useQuery($name.at(scope), input)`** reads once for every component that asks the same thing. An action's `invalidate()` tags refresh the queries and the page that carry those tags.
- **`useRouter()`** gives `navigate`, `revalidate`, `prefetch`, `block`, `pending` and `navigationError`. `navigate(to, { ifCurrent: scope.navigation })` moves only if that page is still the one on screen. A page read ahead with `prefetch` is kept for `psx.prefetch_ttl_seconds`, twenty of them at the most, and all are dropped when a write is sent or who is signed in changes: a navigation never shows what a page was before a save.
- **Query answers** are kept while a component reads them and `psx.query_cache_gc_seconds` after the last one stopped, up to `psx.query_cache_entries` and `psx.query_cache_bytes`; past either, what was used longest ago and is read by nobody goes first.
- A module may also export `RouteError` (shown when its loader refuses), `ErrorBoundary` and `Pending`.

A component with its own query is a `.psx` file declared with `service()`. One mounted once on a path without parameters is called without a scope. Another file imports its bindings with `import { $findPosts } from './PostFinder.psx?server'`.

## Commands

| Command | |
| --- | --- |
| `php cua dev` | The server, the compiler and Vite. TSX edits are refreshed in place; a PHP edit starts a new server and reloads the page; a file that does not compile leaves the last good server running |
| `php cua psx:check` | Compiles, defines the application against the result, and runs TypeScript. Non-zero on any problem |
| `php cua psx:build` | One release: the PHP, the scripts and, when a page asks for it, the renderer. Selected only when all of it built |
| `php cua psx:list` | Pages, layouts, guards, queries and actions with their addresses |
| `php cua psx:types` | Writes `.psx/` for an editor or a CI check, without building |
| `php cua psx:init` | The scaffold. `--force` replaces files |

`php cua start` serves the release `build/psx/current` names and refuses to start without one. `psx:build` and `dev` select a release only after a fresh process has defined the application against it, and `psx:build` publishes scripts only after that.

### What a script may import

`build/`, `storage/`, `vendor/`, `config/`, `database/`, `app/` and `routes/` are the server's, as are files that hold PHP (`.psx` among them) and `.env*` anywhere. The Vite plugin gives no script a file of them, whatever its type and however it is imported (a module, JSON, `?raw`, `?url`, an asset), and `psx:build` reads the list of every file the bundle was made of and refuses to publish a release that names one. Importing a `.psx` file gives its compiled component or bindings, never the file. Nothing under `vendor/` is exempt, also not a folder with a `package.json` or one linked from `node_modules/`: install front-end packages with npm.

## Rendering on the server

`'rendering' => 'server'` in `config/psx.php`, or `->rendering('server')` on a page, renders the first HTML with Node. `psx:build` then also builds `ssr/server.mjs`, and `php cua start` runs it as a supervised process that listens on a private Unix socket in `storage/psx/`. It is given the page's public data and, when the application sets one, the document's nonce; nothing else of the request. Under `php cua dev` Vite renders. With the default, `client`, production needs no Node.

- **One renderer to a server process.** The socket is `storage/psx/ssr-{build}.{pid}.sock`, mode 0600 in a folder of mode 0700: the release it renders and the server process it belongs to. A worker that answers requests starts only once its renderer listens, and stays connected to it until it has stopped; a renderer told to stop goes on rendering until the last such worker has. So a server that has just started or reloaded renders its first page, and a page under way when the server is reloaded is still rendered. A socket left by a server process that was killed is removed when the next one starts.
- **No renderer, no server.** A worker waits five seconds for the renderer; without it the worker does not start, and the framework starts it again. A server whose renderer never listens is never ready: `php cua start --daemon` and `php cua reload` fail after the framework's twenty seconds, and a reload leaves the server that worked serving. See the constraint below for a server that is already running.
- **Only the renderer the server runs.** With `psx.ssr.supervise` off, or a `RendererTransport` of your own, the renderer is yours to start and stop: a worker does not wait for it and keeps no connection to it. Making the connection takes a quarter of a second at the most, the whole of it, and holds up no other request of the worker; it is made again, a second apart at the least, when the renderer was restarted.
- **Bounds.** A worker has at most `psx.ssr.max_inflight` pages (16) at the renderer at once; past that a document is answered `503` with `Retry-After: 1`, never rendered another way. The renderer runs `max_inflight` renders and queues `psx.ssr.max_queue`; a render is given `psx.ssr.timeout_seconds`. A render that never settles holds its place until the renderer is restarted: the time limit answers the request, it cannot stop JavaScript that is running.
- **A renderer that dies** is started again by the server (about two and a half seconds on the machine this was measured on). Documents asked for meanwhile are `503 The renderer is not running.`
- **Hydration.** The browser takes over the server's markup as the server made it. A navigation started before the page's own code arrived, still on its way or failed, is shown after that, as any update; a page or a change of who is signed in that took the document's place before its code arrived is rendered anew instead, without waiting for that code.
- **Inline styles.** React writes a `style` prop as a `style` attribute in the server's markup. Under a policy with `style-src 'self'` the browser refuses it; use classes on pages rendered by the server, or allow it in the policy.

> **Deployment constraint: with server rendering, the renderer is part of the server.**
> A renderer that goes down is started again by the server, and pages are `503` meanwhile while everything else is answered. But if it stays down (Node missing or broken, a renderer that fails as it starts) and a worker has to be started in that time, because one ended, that worker cannot start. After six failed starts in a minute the framework stops the **whole server**, routes that render nothing included. In the test of this, a server with two workers stopped about fifty seconds after one worker was lost; until then the other went on answering.
> With `'rendering' => 'client'` there is no renderer and none of this applies.

What to watch, and how to put it right:

- **Watch a page, not only the health route.** The application's health route says the server answers; it stays `200` while every page is `503`. Probe a server-rendered page as well. `php cua status` shows `psx-ssr` and how often it was restarted. In the log, in the order they get worse: `The renderer is not running.`, `the renderer did not listen within 5 seconds`, `exceeded five restarts in sixty seconds`.
- **While the server still runs**, fix what keeps Node from starting. The server starts the renderer by itself, about every two seconds, and nothing needs to be restarted: in the test pages were rendered again 2.7 seconds later. A process that hangs in the renderer's place has to be ended first.
- **After a server was killed outright** (`SIGKILL`, the machine's out-of-memory killer), look for a `ssr/server.mjs` process it left and end it: the renderer is not told when PHP dies that way. This is an open defect. A server that was stopped leaves none.
- **After the server stopped**, fix the renderer and start the server: `php cua start --daemon`, or let the process manager do it. It will not start before the renderer can; that is the same rule. Run it under a process manager that starts it again.
- **`RendererTransport`** is `render(array $envelope, ?string $nonce = null): string`. An application that binds its own implementation (to render somewhere else, or in a test) must declare the second parameter: PHP does not accept an implementation without it.

## Content Security Policy

PSX writes no inline script of its own that runs: the bootstrap is JSON in a `<script type="application/json">`. Set the request attribute `csp_nonce` in a middleware and PSX puts it on the module scripts of the document, and, on a page rendered by the server, on the one inline script React itself writes (the one that replays a form sent before the page started). No other script is given it.

```php
$nonce = rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
$response = $next->handle($request->withAttribute('csp_nonce', $nonce));
return $response->withHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self' 'nonce-{$nonce}'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
);
```

That policy is what the acceptance tests run a built application under, rendered in the browser and by the server. An answer the framework writes outside the application's middleware (its plain-text 500, for one) carries no policy unless the application's error handling adds it. `php cua dev` needs a looser policy, or none: Vite's client and its refresh code are inline.

## Deploying

```sh
php cua psx:build            # a new release beside the others, selected only when all of it built
php cua start --daemon       # once
php cua reload               # after each build: a new server takes over, the old one finishes what it has
```

- **A release** is `build/psx/releases/{id}`; `build/psx/current` is a link to the one served. Its scripts are published under `public/assets/psx/` beside those of earlier releases and never removed by a build, so a tab of an earlier release still finds its files. Remove old ones yourself once no tab can still hold them.
- **A reload** needs a server started with `--daemon`. The new server answers once it is ready (with its renderer, where there is one); the old one finishes the requests it has and stops. When the application cannot be defined against the selected release, `reload` fails and the old server goes on serving.
- **With server rendering** the renderer is part of the server, and one that stays down can stop all of it: see the constraint under [Rendering on the server](#rendering-on-the-server) before deploying it.
- **A tab of an earlier release** is told so: its writes are refused with 409 before anything is entered and nothing is sent again, its drafts stay on screen, and its next navigation loads one new document.
- **Going back** is selecting the earlier release and reloading: `ln -s releases/{id} build/psx/current.new && mv -T build/psx/current.new build/psx/current && php cua reload`. PSX keeps every release it built; it changes no database, so a rollback across a migration is the application's to plan.
- **What a release's id covers**: the pages' PHP as compiled, the scripts, the runtime they are bundled with, the compiler's output, and the protocol. It does not cover the application's own `src/`, its configuration, or PHP of installed packages that leaves the compiled pages the same: after such a change, reload; tabs keep working, because nothing they hold changed shape.
- **Proxies.** Give the proxy a body limit no smaller than `server.max_body`, or the proxy's own error page answers in place of the application; the page treats that as a failure of unknown outcome (a write is not sent again) and never as a success. The same holds for a proxy's 502, 503 and 504, a login redirect, and an answer cut off part way.
- **A build that fails** selects nothing and publishes nothing: the release served, its PHP and its scripts, is the one from before.

## Testing

```php
use Crab\Psx\Testing\PsxTest;

$psx = PsxTest::boot(dirname(__DIR__))->withHeaders(['Cookie' => "auth={$token}"]);

$psx->navigate('/posts/7')->assertOk();
$psx->action('posts.edit/page', 'savePost', ['id' => 7], ['title' => 'New', 'version' => 1])
    ->assertProblem(409, 'conflict', 'entered');
```

`PsxTest` sends real requests through the application's middleware, router and binder. In TypeScript, `createTestApp()` of `@crabphp/psx/testing` runs an application against fixtures that are held to the shapes the server declares.

## Checks

```sh
composer test && composer format:check && composer lint      # PHP
cd js && npm test && npm run typecheck && npm run format:check && npm run build
cd tests/acceptance && npm install && node run.mjs --mode=all   # real Chromium against the packed packages
```

The last is described in [tests/acceptance/README.md](tests/acceptance/README.md).

## Documents

- [docs/STATUS.md](docs/STATUS.md): milestone checklist, feature matrix, deviations from the design, known gaps.
- [docs/reports/production-readiness.md](docs/reports/production-readiness.md): each acceptance gate with its evidence, the measurements, the supported limits and what is still open.
- [docs/IMPLEMENTATION-REPORT.md](docs/IMPLEMENTATION-REPORT.md): what was built, the commands run and their results.
- [docs/DESIGN.md](docs/DESIGN.md), [docs/DESIGN-OVERVIEW.md](docs/DESIGN-OVERVIEW.md), [docs/reviews/](docs/reviews): the reviewed design and its review reports, copied unchanged from `brainstorm/psx`.
