# Coordinator validation of the PSX fixes

2026-11-15. This records ordinary build/test verification of the completed implementation pass, not final independent security acceptance.

## Independently executed checks

| Tree | Command | Result |
| --- | --- | --- |
| `crabphp/framework` | `composer test` | Exit 0; 2,412 tests, 40,391 assertions, 44 skipped; 2m59.950s |
| `crabphp/framework` | `composer format:check`, `composer lint` | Exit 0; formatter clean; three existing lint help messages under `src/Engine/Process/` |
| `crabphp/psx` | `composer test` | Exit 0; 164 tests, 1,087 assertions |
| `crabphp/psx` | `composer format:check`, `composer lint` | Exit 0, clean |
| `crabphp/psx/js` | `npm test` | Exit 0; 222 tests in five files |
| `crabphp/psx/js` | `npm run typecheck`, `npm run format:check`, `npm run build` | Exit 0 for each |
| `crabphp/psx-demo` | `composer test` | Exit 0; six tests, 88 assertions |

The full framework run followed the last framework change. The later private-file and route-reachability corrections did not change framework code. The package/client/demo checks were run after those corrections.

Logs:

- `/tmp/psx-security-check-3vi030sy/framework-final.log`
- `/tmp/psx-final-checks-158yhqv2/checks.log`

The implementer's separate framework execution had 40,393 assertions; these are two different passing executions, not one result. The two-assertion difference has not been explained.

## Implementation decisions

- Keep `vendor/` private, including a package containing `package.json` and links from `node_modules/`. No public-package allowlist API was approved or implemented. Normal npm-installed frontend packages remain supported.
- Route expansion uses conservative structural overlap checks, including earlier ordinary routes, rather than sample addresses. Ordinary router precedence is unchanged. Expressions the checker cannot prove disjoint may be rejected; this limitation is documented.
- The implementer reports an isolated SSR build and 14/14 Chromium tests after the final corrections. The coordinator did not independently rerun that browser suite.
- The live preview on port 8094 was not rebuilt/restarted by the coordinator. Passing unit/build checks does not establish which client generation an already-open preview tab uses.

## Review boundary

Codex/Astra independently reviewed earlier checkpoints and supplied findings that drove the fixes. Its later turn hit an explicit provider cybersecurity-access restriction. It was not retried, routed through another reviewer, or treated as approval. The saved/refused final response was not retrieved by an alternate route.

The final fixes therefore still lack the requested complete independent Codex re-review. Read `crabphp/psx/docs/reviews/implementation-round-1-server-build-fixes.md` for per-finding implementation evidence and outstanding coverage, not as an independent acceptance statement. No editor extension, full deployment/performance acceptance, or real-browser cross-tab/versioned-auth proof is claimed by these checks.

**Implementation pass finished; ordinary checks passed; final independent review remains blocked. The package is not accepted as production-ready. No commits, pushes, publishing, or deployment were performed.**
