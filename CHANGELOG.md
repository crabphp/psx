# Changelog

PSX follows [semantic versioning](https://semver.org). Before 1.0, a minor version may break what an application writes; the entry says what to change. The Composer package `crabphp/psx` and the npm package `@crabphp/psx` are released together, with the same version.

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
