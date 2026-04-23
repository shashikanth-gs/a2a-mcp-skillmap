# Contributor Guide

## Development setup

```bash
git clone <repo>
cd a2a-mcp-skillmap
npm install
```

Everything runs in Node.js (≥ 20). No external services are required; tests use stub dispatchers and the in-memory storage backends.

## Workflow

```bash
npm run test            # vitest (unit + property + integration)
npm run test:coverage   # with v8 coverage report
npm run lint            # eslint + tsc --noEmit
npm run format          # prettier write
npm run build           # tsc → dist/
```

Before opening a PR, run `npm run lint && npm run test:coverage` and ensure coverage meets the thresholds (statements ≥ 85%, branches ≥ 80%).

## Commit convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: …` — new user-facing capability
- `fix: …` — bug fix
- `docs: …` — documentation only
- `refactor: …` — internal change without behavior diff
- `test: …` — tests only
- `chore: …` — tooling / deps / ignore files
- `perf: …` — measurable performance improvement

Breaking changes: add `BREAKING CHANGE:` footer or `!` after type (`feat!:`). A change to `ToolNamingStrategy.deriveName()` output MUST be a `major` release.

## Review process

Every PR requires:
1. One approving review from a maintainer.
2. Passing CI: lint + unit + property + integration + coverage gate.
3. No unreviewed public-API changes — update `docs/api-reference.md` in the same PR.

## Release process

- Releases are cut from `main` when CI is green.
- Semantic-Versioning is enforced by the commit log: `feat` → minor, `fix` → patch, any `!` / `BREAKING CHANGE:` → major.
- `CHANGELOG.md` is generated from the commit log; hand-edit only for wording.
- `npm publish` is automated via CI on release tags; local publishing is not supported.

## Architecture pointers

- **Canonical model**: `src/types/index.ts` — everything else converts to/from these types.
- **Transport independence**: the core engine (`src/core/engine.ts`) has zero knowledge of stdio vs HTTP. Adapters live in `src/mcp/`.
- **Pluggable interfaces**: projector, naming strategy, auth, storage — all have `Default*` implementations and accept drop-in replacements via `createBridge` options.

## Writing tests

Property tests go in `tests/property/<subject>.property.test.ts`. Include a comment tag:

```ts
// Feature: a2a-mcp-skillmap, Property N: <name>
```

Minimum 100 `numRuns` per property. Integration tests in `tests/integration/` should use in-memory storage and stub dispatchers — no network I/O.

## ADRs

Architectural Decision Records live in `docs/adr/`. When proposing a change that affects the public surface, add an ADR that states: context, decision, consequences, and alternatives considered.
