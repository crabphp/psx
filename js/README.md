# @crabphp/psx

The browser half of [PSX for Crab](../README.md): the React runtime, the support for generated bindings, the Vite plugin, the renderer for server rendering, and test helpers.

| Import | |
| --- | --- |
| `@crabphp/psx` | `start`, `Link`, `useRouter`, `useQuery`, `useQueryClient`, `clientOnly`, `RequestFailure`, `QueryProblem`, `QueryRedirect`, and the types |
| `@crabphp/psx/vite` | `psx()`, the Vite plugin. It includes `@vitejs/plugin-react` once |
| `@crabphp/psx/bindings` | What generated files import. Not for application code |
| `@crabphp/psx/ssr` | `renderPage`, `serve`: the renderer a build bundles |
| `@crabphp/psx/testing` | `createTestApp`, `FixtureTransport`, `problem`, `redirect` |

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { psx } from '@crabphp/psx/vite';

export default defineConfig({ plugins: [psx()] });
```

```tsx
// resources/entry.tsx
import { start } from '@crabphp/psx';

start({ root: document.getElementById('app')! });
```

Vite is started by `php cua dev` and `php cua psx:build`, which compile the pages first. Started alone it stops and says so.

```sh
npm test            # Vitest
npm run typecheck
npm run build       # dist/, which an application linked from this folder uses
```

React 19.2 and Vite 8 are peers. Built and tested with TypeScript 7 and Node 24.
