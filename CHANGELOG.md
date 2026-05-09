# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-05-09

### Added
- **`artifact` response mode — new default.** Multimodal unwrapping: every A2A part becomes a native MCP content block. `text` parts → text blocks; `file` parts with inline image/audio bytes → `image` / `audio` blocks; `file` parts with URIs → `resource_link` blocks; `data` parts → stringified-JSON text blocks. Non-image/non-audio inline files degrade to `[file: <name>]` placeholders (no base64 blobs inlined). Parts from multiple artifacts are flattened in order. See the [operator guide](docs/operator-guide.md#response-modes) for a side-by-side multimodal example.
- Task management tools renamed `task.status` → `task_status`, `task.result` → `task_result`, `task.cancel` → `task_cancel` so names satisfy strict MCP clients (VS Code enforces `^[a-z0-9_-]+$`).
- Zero-skill agent handling: new `fallbackTool` config (`none` | `message`, default `message`) synthesizes a `{agent}__message` tool whose description carries the agent's identity, so clients can still talk to agents that advertise no skills.
- `AgentResolver` + `DefaultA2ADispatcher` now accept either a base URL or an explicit agent-card URL. Base URLs probe `.well-known/agent-card.json`, then `.well-known/agent.json` (legacy). Explicit `.json`/`.yaml`/`.yml` URLs are used verbatim.
- `examples/sample-agent/` — deterministic, no-LLM sample A2A agent (three skills exercising fast-path, blocking-task, and streaming-task reply shapes) for end-to-end testing and onboarding.
- Examples directory (`examples/`) covering every CLI / env / config / programmatic permutation.
- GitHub Actions workflows: `ci.yml` (matrix lint + test on Node 18/20/22) and `publish.yml` (publishes to npm on Release with version/tag consistency check and provenance).

### Changed
- **Default `responseMode` is now `artifact`** (was `structured`). Clients that depended on `structuredContent` must explicitly set `responseMode: 'structured'`.
- `raw` response mode widened: (a) multi-artifact responses are now emitted as a JSON array instead of silently keeping only the first; (b) the same payload is also exposed via `structuredContent.raw` so programmatic consumers don't have to re-parse the text block.
- `ResolvedAgent` now carries the `cardUrl` it was actually fetched from, separate from the operator-supplied `url`.

### Fixed
- Card URL handling: passing a full `.well-known/agent-card.json` URL no longer double-appends the path and 404s.
- CLI stdio bridge silently exited with code 0 when launched via `npx` from any path traversing a symlink (notably `/tmp` on macOS, which is a symlink to `/private/tmp`). The main-module guard now canonicalizes both `import.meta.url` and `process.argv[1]` via `fileURLToPath` + `realpathSync` before comparison, so the bridge starts correctly under symlinked layouts (macOS `/tmp`, pnpm content-addressable stores, nvm node symlinks, Docker bind mounts, Windows path-casing differences).

### Removed
- Internal ADR drafts under `docs/adr/` are no longer checked in. They lived ahead of implementation and have since been superseded by the design doc and code; keeping them in-tree was creating drift. The directory is now ignored.

### CI
- `.github/workflows/publish.yml` now also publishes on push-to-`main` whenever the commit bumps `package.json` version (in addition to the existing GitHub Release trigger). Push trigger is restricted to `main` only and gated by the same `ENABLE_NPM_PUBLISH` variable + `NPM_TOKEN` secret. After a successful publish on the push path, the workflow auto-creates the matching annotated tag and a generate-notes GitHub Release.

## [0.1.0] — 2026-04-23

### Added
- Initial public release.
- Canonical model + Zod-validated `BridgeConfig` schema with three-tier precedence loader (CLI > env > file).
- A2A layer: `AgentResolver`, `SkillNormalizer` (JSON Schema draft-07 subset → Zod), `DefaultA2ADispatcher` backed by `@a2a-js/sdk`.
- Core engine: `AgentRegistry` with retry + backoff, `ToolGenerator`, `DefaultToolNamingStrategy`, `InvocationRuntime` with input-validation gate, `TaskManager` with explicit state machine, `DefaultResponseProjector` (structured / compact / raw modes).
- Auth: bearer, api_key, and none — both inbound (HTTP) and outbound (per-agent); `redactedDescription()` guarantees tokens never leak to logs.
- Transports: stdio adapter via `@modelcontextprotocol/sdk`'s `StdioServerTransport`; HTTP adapter on Express with `StreamableHTTPServerTransport`.
- CLI entry point (`a2a-mcp-skillmap`) with commander-based flag parsing.
- Observability: pino-based structured logger with credential redaction, telemetry-event emitter, optional OpenTelemetry bridge.
- All 17 correctness properties validated by fast-check property tests.

### Versioning note
A change to `DefaultToolNamingStrategy.deriveName()` output is considered a **breaking** change and will be shipped as a major-version bump, since it alters the tool namespace surfaced to MCP clients.
