# Operator Guide

## Transports

The bridge supports two transports, selected via `--transport`:

- **`stdio`** (default): ideal for local MCP clients that spawn the bridge as a child process. Everything runs in-process; no port binding.
- **`http`**: the bridge listens on the configured port and serves an MCP StreamableHTTP endpoint at `POST /mcp`. Use this when the MCP client lives on a different host, or when you need to terminate TLS at a reverse proxy.

Stdio has the lowest overhead and is the right choice for single-user tooling. HTTP is the right choice for multi-tenant or networked deployments.

## Authentication

### Inbound (MCP clients calling the bridge)

Only applies when `transport=http`. Configure via `http.inboundAuth`:

```json
"http": {
  "port": 3000,
  "inboundAuth": { "mode": "bearer", "token": "..." }
}
```

`mode` can be `none`, `bearer`, or `api_key`. For `api_key`, set `headerName` (defaults to `X-API-Key`). Credentials are read from config or environment only — they are NOT accepted on the CLI flag surface, to avoid leaking into shell history.

### Outbound (bridge calling A2A agents)

Per-agent in the `agents[]` array:

```json
{
  "url": "https://agent.example.com",
  "auth": { "mode": "bearer", "token": "..." }
}
```

When misconfigured (mode = `bearer` or `api_key` without a token), startup logs a structured error and that agent is rejected; other agents continue to load.

## Response modes

Every invocation result is shaped through one `ResponseMode` before being handed to the MCP client. Selected via `--response-mode`, env `A2A_MCP_RESPONSE_MODE`, or `responseMode` in the config file. **Default: `artifact`.**

| Mode | Best for | Multimodal? | `structuredContent`? |
|---|---|---|---|
| [`artifact`](#artifact-default) (default) | LLM / chat UI consumers that want the agent's content — text, images, audio, files — mapped to native MCP blocks | ✓ text, image, audio, resource_link | — |
| [`structured`](#structured) | Clients that also need the bridge's metadata (correlation IDs, duration, task ids) | — (single text fallback) | ✓ canonical envelope |
| [`compact`](#compact) | Bandwidth or token-budget constraints | — | — |
| [`raw`](#raw) | Debugging, analytics, protocol-aware forwarding | — | ✓ canonical envelope + `raw` |

The examples below use the `current_time` skill from `examples/sample-agent`, which returns an A2A `Message` whose first part is a text part containing an ISO timestamp. A fifth example at the end shows multimodal payloads.

### `artifact` (default)

Unwraps every artifact's `parts[]` into native MCP content blocks, one per part. Multimodal-aware:

| A2A part | MCP block emitted |
|---|---|
| `kind: "text"` | `{ type: "text", text }` |
| `kind: "file"` with `bytes` + `mimeType: "image/*"` | `{ type: "image", data: bytes, mimeType }` |
| `kind: "file"` with `bytes` + `mimeType: "audio/*"` | `{ type: "audio", data: bytes, mimeType }` |
| `kind: "file"` with `uri` | `{ type: "resource_link", uri, name, mimeType? }` |
| `kind: "file"` with `bytes` + other mime (PDF, binary) | `{ type: "text", text: "[file: <name>]" }` — placeholder; base64 blobs intentionally not inlined |
| `kind: "data"` | `{ type: "text", text: JSON.stringify(data) }` — nothing silently dropped |

Parts from multiple artifacts are flattened in order. Plain-string payloads pass through as a single text block. Unknown shapes fall back to JSON text.

Example (text part only):

```json
{
  "content": [
    { "type": "text", "text": "2026-04-24T00:00:00.000Z" }
  ]
}
```

Example (multimodal — text + image bytes + pdf link + audio bytes + data):

```json
{
  "content": [
    { "type": "text", "text": "Here is your chart." },
    { "type": "image", "data": "QkFTRTY0UElYRUxT", "mimeType": "image/png" },
    { "type": "resource_link", "uri": "https://cdn.example/report.pdf", "name": "report.pdf", "mimeType": "application/pdf" },
    { "type": "audio", "data": "QkFTRTY0", "mimeType": "audio/mpeg" },
    { "type": "text", "text": "{\"rows\":42}" }
  ]
}
```

Use it for agents whose output the client will display or feed to an LLM. An MCP-aware client will render each block natively — text reads as text, images show as images, audio plays, resource links open or download.

### `structured`

Full canonical envelope in `structuredContent` plus one short human-readable text fallback in `content`.

```json
{
  "content": [
    { "type": "text", "text": "success: 1 artifact from current_time on http://127.0.0.1:4003" }
  ],
  "structuredContent": {
    "status": "success",
    "artifacts": [
      {
        "type": "application/json",
        "data": {
          "kind": "message",
          "role": "agent",
          "parts": [{ "kind": "text", "text": "2026-04-24T00:00:00.000Z" }],
          "messageId": "...",
          "taskId": "...",
          "contextId": "..."
        }
      }
    ],
    "metadata": {
      "agentUrl": "http://127.0.0.1:4003",
      "skillId": "current_time",
      "durationMs": 12,
      "correlationId": "..."
    }
  }
}
```

Use it when your client benefits from both the text block and a parseable structured body carrying the bridge's metadata.

### `compact`

One summary string, ≤ 280 chars, in `content`. No `structuredContent`.

```json
{
  "content": [
    { "type": "text", "text": "success: 1 artifact(s) from current_time." }
  ]
}
```

Use it when every token/byte matters. The full payload is dropped; you get status + artifact count + skill id and nothing else.

### `raw`

Every artifact's `data` field, byte-for-byte, in both the text content and `structuredContent.raw`. One artifact → data emitted as-is; multiple artifacts → emitted as an array so nothing is dropped.

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"kind\":\"message\",\"role\":\"agent\",\"parts\":[{\"kind\":\"text\",\"text\":\"2026-04-24T00:00:00.000Z\"}],\"messageId\":\"...\",\"taskId\":\"...\",\"contextId\":\"...\"}"
    }
  ],
  "structuredContent": {
    "status": "success",
    "artifacts": [ /* as in structured mode */ ],
    "metadata": { /* ... */ },
    "raw": {
      "kind": "message",
      "role": "agent",
      "parts": [{ "kind": "text", "text": "2026-04-24T00:00:00.000Z" }],
      "messageId": "...",
      "taskId": "...",
      "contextId": "..."
    }
  }
}
```

Use it when the downstream consumer is protocol-aware and wants to inspect A2A's own event shape — debugging, analytics, replay, round-tripping.

### Deciding

Keep the default **`artifact`** for almost every consumer: MCP clients render each block natively, so the agent's full content reaches the user with the right UI treatment. Switch to **`structured`** when your consumer needs metadata (correlation IDs, durations, task IDs) alongside the content. Switch to **`compact`** only when bandwidth is the bottleneck. Switch to **`raw`** for debugging or when forwarding the A2A payload unchanged to another system.

### Changing mode at runtime

Three equivalent knobs, precedence CLI > env > file:

```bash
npx -y a2a-mcp-skillmap --a2a-url http://localhost:4003 --response-mode structured
```

```bash
A2A_MCP_RESPONSE_MODE=structured npx -y a2a-mcp-skillmap --a2a-url http://localhost:4003
```

```json
{ "agents": [ ... ], "responseMode": "structured" }
```

## Observability

### Logging

Logs are JSON lines on stdout (pino format). Every entry carries a `correlationId` when emitted inside a tool invocation (Property 17). Credentials are redacted via `pino`'s `redact` configuration — they are replaced with `[REDACTED]` at emission time, so they never touch the logging pipeline.

### OpenTelemetry

OpenTelemetry is an optional peer dependency. To enable span emission:

```ts
import { setOtelTracer } from 'a2a-mcp-skillmap';
import { trace } from '@opentelemetry/api';

setOtelTracer(trace.getTracer('a2a-mcp-skillmap'));
```

When no tracer is registered, `withSpan` calls are no-ops and OTel is never imported.

### Telemetry hooks

For structured in-process consumption without parsing logs:

```ts
import { Telemetry } from 'a2a-mcp-skillmap';

const telemetry = new Telemetry();
telemetry.subscribe((event) => {
  // event.kind: 'invocation.start' | 'invocation.end' | 'agent.resolve' | 'task.transition'
});
```

## Retry & resilience

Agent card resolution retries with exponential backoff (`retry.maxAttempts` × `retry.initialDelayMs × 2^(n-1)` plus ±10% jitter). Failures after the retry budget terminate startup with a non-zero exit — if one agent of many fails, the rest continue; if zero agents resolve, the bridge exits.

## Graceful shutdown

The CLI handle returned by `runCli` exposes `stop()`. When running as a process:

- stdio: close STDIN from the client side.
- http: SIGINT / SIGTERM — wire your own signal handler via the SDK API if you need custom teardown.

## Reference performance

Measured on a 2022 M1 MacBook Air, stdio transport, fast-path:

| Metric | Value |
|---|---|
| p50 invocation latency | ~2 ms |
| p95 invocation latency | ≤ 25 ms |
| HTTP throughput | ≥ 200 req/s (stateless) |

These are the baselines the CI performance gate enforces. Production numbers depend on the A2A agent's response time, which is outside the bridge's control.
