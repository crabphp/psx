# PSX design

A complete proposed PHP + React integration for CrabPHP. **Design only: no package implementation or production-readiness claim.**

Read the [full specification](DESIGN.md). It covers the source language, PHP and React APIs, routing/layouts/components, loading and caching, forms, errors, security, SSR, developer tooling, deployment, and release gates.

## Recommended shape

```text
.psx file
    PHP Server class     → CrabPHP, constructor DI, typed methods
    normal React TSX     → browser components, hooks, events, libraries

Compiler
    private PHP + manifest
    public stripped TSX + assets
    generated operation/route/props types
    optional matching React SSR bundle
```

Three server operations, not one generic action mechanism:

| Operation | Purpose | React interface |
| --- | --- | --- |
| `load()` | Page/layout data for document, navigation and revalidation | Typed `data` prop |
| `#[Query]` | Reusable read | `$searchPeople(...)`, `useQuery(...)` |
| `#[Action]` | Mutation | `$savePost.at(scope)(input)` or `.form(formData)` |

Scoped operations use **immutable explicit scope**, so an old post-A callback cannot silently save post B after navigation. Single-mount pathless services can be called directly. `$` names are generated bindings, not an instruction to expose every PHP function.

## Review the APIs first

- [Source grammar and module shape](DESIGN.md#4-the-psx-language)
- [Complete editing-page example](DESIGN.md#5-a-complete-editing-page)
- [PHP registration and result APIs](DESIGN.md#6-php-api)
- [Layouts, reusable components, and service mounting](DESIGN.md#7-routes-layouts-and-reusable-components)
- [React/TypeScript API](DESIGN.md#10-react-and-typescript-api)
- [Navigation and history](DESIGN.md#11-navigation-history-and-accessibility)
- [Queries, caches, and invalidation](DESIGN.md#12-data-loading-queries-and-caches)
- [Forms and mutation semantics](DESIGN.md#13-actions-forms-and-concurrency)

## Production behavior is part of the design

- Ordinary Crab routing/middleware/typed validation; no bypass dispatcher.
- No shared request state in long-running PHP workers.
- Composite page/layout query schemas and separate typed loader payloads.
- Real React form semantics, including controlled drafts and `useActionState` adapters.
- Expected problems distinct from transport failures and uncertain mutation outcomes.
- Explicit navigation generations, auth reconciliation, bounded private caches.
- No mutation retries, redirect-followed resubmissions, or automatic post-deploy replay.
- Strict serialization and parsing; files remain multipart uploads.
- Server code excluded from bundles, source maps, HMR, overlays, and raw endpoints.
- CSR without a Node server; optional SSR through a private, versioned local renderer.
- One dev command, clean-checkout compilation, coordinated PHP/JS builds and safe reloads.

See [protocol](DESIGN.md#16-http-protocol), [security](DESIGN.md#17-authentication-authorization-and-security), [SSR](DESIGN.md#19-server-rendering), [tooling](DESIGN.md#21-compiler-editor-and-developer-workflow), and [deployment](DESIGN.md#22-builds-deployments-and-compatibility).

## Concrete framework work required

The current framework does not already expose everything PSX needs. The specification identifies prepared raw-result action invocation, declaration collection/finalization, composable protocol errors/auth refusals, strict request decoding, and compiler/watcher readiness integration.

Read [required core changes](DESIGN.md#25-required-crabphp-integration-changes) before implementation, then the [production acceptance gates](DESIGN.md#26-production-acceptance-gates). Ordinary Crab API applications must retain their current behavior.

## Scope boundaries

This is not React Server Components or React Flight. Function-action forms require JavaScript; no-JS-critical forms use ordinary Crab POST/Redirect/GET routes. Remote SSR, deferred loader streaming, automatic offline mutation replay, a new ORM and a parallel form-state framework are not claimed capabilities.

The detailed APIs are proposals awaiting owner approval, especially the class-shaped PHP section, `.at(scope)` binding, explicit route registration and required core extension contracts.

## Research and review

Two Astra 6 agents independently reviewed the backend and client sides, then reviewed the combined specification:

- [Backend integration research](reviews/server.md)
- [React/client research](reviews/client.md)
- [Backend consistency findings](reviews/server-final.md)
- [Client consistency findings](reviews/client-final.md)
- [Backend recheck](reviews/server-recheck.md) — no remaining blocking contradictions found
- [Client recheck](reviews/client-recheck.md) — no remaining blocking contradictions found

The `*-final.md` files are findings against an earlier revision, not statements that every finding remains open. The design was revised from them; recheck reports record the follow-up. No framework source was changed.
