# ADR-004: Response Mode Contract

**Date:** 2025-01-15 (revised 2026-04-24 for `artifact` multimodal unwrapping)

**Status:** Accepted

## Context

MCP clients have varying capabilities and expectations for tool response payloads. Some want the agent's content rendered natively (text as text, images as images, audio as audio); some also need the bridge's metadata (correlation IDs, durations, task ids); some prefer concise summaries; some need the raw upstream payload for custom processing. The bridge must serve all four use cases from the same canonical result without requiring per-client code paths in the core engine.

A2A is a multimodal protocol: a `Message` carries a `parts[]` array where each part is a `text`, `data`, or `file` part, and file parts may carry inline base64 bytes or a URI. Client experience suffers badly if the bridge collapses this into a single text blob — an image ends up as opaque JSON, a PDF link ends up as a string the client can't click.

A single fixed response format would force either:

- All clients to parse A2A's `parts[]` themselves (negates the bridge).
- All clients to accept a lossy summary (insufficient for clients that need full content or metadata).
- All clients to handle the raw A2A envelope (defeats normalization).

## Decision

The bridge supports four `ResponseMode` values — `artifact`, `structured`, `compact`, and `raw` — configured per deployment via CLI flag, environment variable, or configuration file (precedence: CLI > env > config file). The `ResponseProjector` transforms every `CanonicalResult` into an MCP `CallToolResult` according to the active mode. The default is **`artifact`**.

### Artifact Mode (default)

Multimodal unwrapping: every A2A part becomes a native MCP content block. This mode exists because A2A and MCP both model multimodal content as arrays of typed blocks, and the bridge's job is to translate between them faithfully.

Part → Block mapping:

| A2A part | MCP block |
|---|---|
| `{ kind: "text", text }` | `{ type: "text", text }` |
| `{ kind: "file", file: { bytes, mimeType: "image/*" } }` | `{ type: "image", data: bytes, mimeType }` |
| `{ kind: "file", file: { bytes, mimeType: "audio/*" } }` | `{ type: "audio", data: bytes, mimeType }` |
| `{ kind: "file", file: { uri, mimeType?, name? } }` | `{ type: "resource_link", uri, name, mimeType? }` |
| `{ kind: "file", file: { bytes, mimeType: other } }` | `{ type: "text", text: "[file: <name>]" }` |
| `{ kind: "data", data }` | `{ type: "text", text: JSON.stringify(data) }` |

Parts from multiple artifacts are flattened in order. Plain-string artifact data passes through as a single text block. Unknown shapes fall back to JSON text. `structuredContent` is not populated.

**Design choice — no base64 blobs for non-media files.** MCP's embedded `resource` block requires inline text or base64 bytes for any mime type other than image/audio. Inlining arbitrary base64 blobs (PDFs, binaries, archives) would balloon payloads and rarely produces a better client experience than a text placeholder telling the user the file existed. Operators who want full-fidelity byte forwarding should use `raw` mode.

### Structured Mode

Full canonical envelope with maximum metadata fidelity:

- `structuredContent` — the complete canonical result: `status`, `artifacts[]` (each `{ type, data }` carrying the raw A2A payload), `metadata` (agent URL, skill ID, duration, correlation ID, optional A2A task ID), plus `taskId` / `taskState` when it's a task handle.
- `content` — one short human-readable text fallback so clients that can't parse `structuredContent` still get something.

### Compact Mode

Reduced payload optimized for bandwidth and token budgets:

- `content` — a summary string ≤ 280 characters. No artifact data. No metadata.
- No `structuredContent`.

### Raw Mode

Byte-equivalent A2A payload with zero pruning:

- `content` — JSON-serialized artifact data. Single artifact → data emitted as-is; multiple → JSON array.
- `structuredContent` — canonical envelope plus an additional `raw` field carrying the same payload for programmatic access without re-parsing the text block.

### Projection of Long-Running Task Handles

The same four modes apply when projecting task handles (long-path responses) and task status/result responses:

- **Artifact** — parts from every stored artifact flatten into blocks as above. A handle with no artifacts yields one empty text block (required by MCP schema).
- **Structured** — task handle includes `structuredContent` with `taskId`, `taskState`, `a2aTaskId`, `agentUrl`, plus a text fallback.
- **Compact** — task handle is a single text line with task ID and state.
- **Raw** — JSON-serialized task metadata as text plus `structuredContent.raw`.

### Invariants

All four modes guarantee:

1. The output is schema-valid against the MCP tool-result schema, including the multimodal block union.
2. Identical inputs with the same mode produce byte-equivalent outputs (determinism).
3. The mode can be changed at runtime without requiring a bridge restart (on next invocation).
4. No credential value ever appears in any projected output.
5. No A2A part is silently dropped; every kind maps to some content block (or placeholder).

## Consequences

### Positive

- **Multimodal by default.** Images render as images, audio plays, files become clickable links. No protocol-unwrapping code needed client-side.
- **Debuggability.** `raw` mode's `structuredContent.raw` alongside the content text means programmatic clients don't have to re-parse JSON they just produced.
- **Metadata when needed.** `structured` mode remains available for clients that specifically want the bridge's correlation IDs and duration data.
- **Determinism.** Response projection remains a pure function of `(CanonicalResult, ResponseMode)`.
- **Extensibility.** `ResponseProjector` is a pluggable interface; custom modes can be registered via the SDK for specialized deployments.

### Negative

- **Mode awareness.** Operators must understand the tradeoffs. A misconfigured mode (e.g., `raw` for a client expecting multimodal blocks, or `artifact` for a client that needs metadata) may cause client-side confusion.
- **Compact information loss.** The 280-character summary discards data that cannot be recovered without re-invoking or switching modes.
- **Artifact-mode file-blob opt-out.** Non-image/non-audio inline files become text placeholders, not embedded resources. Operators who need full-fidelity file forwarding should use `raw` mode or host the file and return a URI.
- **Data-part coupling.** Stringifying `kind: "data"` parts produces whatever JSON the agent chose — a change in the agent's payload shape reaches the client unchanged. Intentional (no silent loss) but downstream code must tolerate format variation.
- **Raw-mode protocol coupling.** Raw mode exposes the A2A agent's response format directly; upstream protocol changes become visible without the bridge's normalization buffer.

### Mitigations

- Property-based tests (Properties 8, 9, 10) verify mode invariants, schema validity (including the multimodal block union), and determinism across generated canonical results.
- Example-based unit tests cover each part kind → block mapping for `artifact` mode.
- The operator guide documents each mode's behavior with a side-by-side JSON example per mode against the same call, plus a dedicated multimodal example.
- The default mode is `artifact`, which gives most MCP clients (LLMs, chat UIs) the shape they actually want.

## History

- **2026-04-24 (later)** — Renamed the unwrapping mode from `text` → `artifact` to reflect multimodal semantics. Block emission widened: file parts become `image` / `audio` / `resource_link` blocks where possible; non-media inline files become text placeholders. Default flipped from `structured` → `artifact`.
- **2026-04-24 (earlier)** — Added `text` mode (walks `parts[]`, returns the agent's textual answer). Widened `raw` mode to (a) emit all artifacts when there are multiple and (b) expose `structuredContent.raw`.
- **2025-01-15** — Initial version with three modes: `structured`, `compact`, `raw`.
