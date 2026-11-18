# Changelog

PSX follows [semantic versioning](https://semver.org). Before 1.0, a minor version may break what an application writes; the entry says what to change. The Composer package `crabphp/psx` and the npm package `@crabphp/psx` are released together, with the same version.

## 0.2.0 — 2026-11-18

- **Breaking: a page is written as functions.** The PHP block holds `load()` and functions marked `#[Query]` or `#[Action]`, with no class to write. A service is a parameter marked `#[Inject]`, in place of a constructor argument; the compiler makes the class the router calls from the functions, and an error names the function's line. To change a file: write each method as a function, add `#[Inject] Posts $posts` for each service it used and `use Crab\Psx\Inject;`, write `$posts` where it said `$this->posts`, hand a private method's services to it as parameters, and turn class constants into file constants. A file with a `Server` class, or a function using `$this`, is refused with how to change it. Put `#[Inject]` parameters before any with a default.
- **A renderer no longer outlives its server.** The renderer a server runs stops within about a second once the server process that started it is killed outright (`SIGKILL`, the out-of-memory killer), where it used to keep running until someone ended it. It is started with `--exit-with-parent`; a renderer you run yourself is not watched.
- **A renderer leaves the socket of the one started in its place.** When only the worker that runs the renderer was lost, the server starts another renderer at the same address; the old one, stopping, used to remove the new one's socket with its own, since closing a listening socket removes the file at its path. Now only a renderer whose file is still there closes it.
- The Composer package no longer ships `composer.lock`.

## 0.1.0 — 2026-11-18

The first release. A page is one `.psx` file: a PHP `Server` class in a `<script lang="php">` block, and a React component below it. Not production-ready: [docs/STATUS.md](docs/STATUS.md) says what is implemented, what is tested and what is still open.

- **Requires** PHP 8.4, `crabphp/framework` 0.7.5 or later (its contracts for packages), Node 24, React 19.2, TypeScript 7 and Vite 8. Linux or macOS.
- **The file:** the PHP block is found by PHP's own lexer, so a `</script>` in a string, a comment or a heredoc does not end it. It holds imports, types, functions and one `final readonly class Server` with `load()`, `#[Query]` and `#[Action]` methods. The TSX below gets each query and action as a typed `$name`.
- **Declaring pages:** in `routes/pages.php` with `$pages->page()`, `layout()`, `service()` and groups, or beside ordinary routes in `routes/web.php` with `Psx::page()` and the rest. A file is named by its path or by a short name such as `'Posts/Edit'`.
- **Types end to end:** the compiler writes TypeScript for props, inputs, outputs, routes and bindings from the PHP signatures, and the server checks every answer against the same shapes.
- **Server:** each page is a family of ordinary Crab routes behind the application's own middleware, with strict input decoding, the `psx/1` protocol, expected failures as results, redirects, uploads, and a stale tab sent to a fresh document.
- **Browser:** a client router with layouts kept across navigation, immutable scopes, a bounded query cache with tags and invalidation, forms through `useActionState`, and writes that are never retried.
- **Commands:** `php cua dev`, `psx:check`, `psx:build`, `psx:list`, `psx:types` and `psx:init`.
- **Rendering on the server** is built and tested but off by default (`'rendering' => 'client'`): a renderer can outlive a server that is killed outright. Leave it off until that is fixed.
