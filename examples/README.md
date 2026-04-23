# Examples

Every supported way to start the bridge, organized by how you'll actually use it.

## Don't have an A2A agent to test against?

See [`sample-agent/`](sample-agent/) — a stand-alone, no-LLM A2A agent with three skills (immediate-reply, blocking task, streaming task) plus an allowlisted `run_command` skill. It's deliberately simple so you can probe every bridge code path end-to-end without depending on any external service.

```bash
cd examples/sample-agent && npm install && npm start
# then, in another terminal, point the bridge at it:
node ./dist/cli/index.js --a2a-url http://127.0.0.1:4003
```

## Precedence recap

Every setting can come from three sources. Higher beats lower:

1. **CLI flag** (highest)
2. **Environment variable**
3. **Config file** (lowest)

This means you can keep a baseline in `bridge.json`, override per-environment via env vars, and override per-run via CLI flags — without editing anything. Examples below lean into that.

## Map of scenarios

| # | Source mix | Transport | Inbound auth | Outbound (per-agent) auth | File |
|---|---|---|---|---|---|
| 1 | CLI only | stdio | — | none | [CLI scenarios](#1-cli-only) |
| 2 | CLI only | http | — | none | [CLI scenarios](#1-cli-only) |
| 3 | Env vars only | stdio | — | none | [Env-var scenarios](#2-env-vars-only) |
| 4 | Env vars only | http | bearer | none | [Env-var scenarios](#2-env-vars-only) |
| 5 | Config file only | stdio | — | bearer (per-agent) | `configs/stdio-outbound-bearer.json` |
| 6 | Config file only | http | bearer | mixed | `configs/http-full.json` |
| 7 | Config file only | http | api_key | none | `configs/http-apikey.json` |
| 8 | Config file + CLI override | http | bearer | mixed | [Mixed sources](#3-mixed-sources) |
| 9 | Config file + env override | http | bearer | mixed | [Mixed sources](#3-mixed-sources) |
| 10 | Programmatic — minimal | stdio | — | none | `programmatic/minimal.ts` |
| 11 | Programmatic — HTTP + auth | http | bearer | bearer | `programmatic/http-auth.ts` |
| 12 | Programmatic — custom projector | stdio | — | none | `programmatic/custom-projector.ts` |
| 13 | Programmatic — custom storage | http | — | none | `programmatic/custom-storage.ts` |
| 14 | MCP client embed — Claude Desktop | stdio | — | — | `mcp-clients/claude-desktop.json` |
| 15 | MCP client embed — VS Code | stdio | — | — | `mcp-clients/vscode.json` |
| 16 | MCP client embed — networked (HTTP) | http | bearer | — | `mcp-clients/http-client.md` |

---

## 1. CLI only

### Stdio, one agent, no auth (the 30-second path)

```bash
npx a2a-mcp-skillmap --a2a-url https://agent.example.com
```

### Stdio, multiple agents

```bash
npx a2a-mcp-skillmap \
  --a2a-url https://agent-a.example.com \
  --a2a-url https://agent-b.example.com
```

### Stdio with response-mode override

The bridge supports four modes — `artifact` (default), `structured`, `compact`, `raw`. See the [operator guide](../docs/operator-guide.md#response-modes) for side-by-side examples, including a multimodal one.

```bash
# Structured — canonical envelope + metadata for clients that need correlation IDs, durations, etc.
npx a2a-mcp-skillmap --a2a-url https://agent.example.com --response-mode structured

# Compact — 280-char summary, lowest tokens
npx a2a-mcp-skillmap --a2a-url https://agent.example.com --response-mode compact

# Raw — byte-equivalent A2A payload (best for debugging or protocol-aware consumers)
npx a2a-mcp-skillmap --a2a-url https://agent.example.com --response-mode raw
```

Default is `artifact`, which unwraps A2A parts into native MCP blocks — text, image, audio, resource_link — so MCP clients render each block natively.

### HTTP, one agent, no inbound auth

```bash
npx a2a-mcp-skillmap \
  --a2a-url https://agent.example.com \
  --transport http \
  --port 3000
```

### HTTP + log-level override

```bash
npx a2a-mcp-skillmap \
  --a2a-url https://agent.example.com \
  --transport http \
  --port 3000 \
  --log-level debug
```

> **Why CLI can't carry tokens.** Inbound and outbound credentials are intentionally not accepted as CLI flags — they'd leak to shell history and `ps`. Use env vars or a config file for anything with a `token`.

---

## 2. Env vars only

Every CLI flag has an env var equivalent. See [`docs/cli-reference.md`](../docs/cli-reference.md) for the full list.

### Stdio, one agent

```bash
A2A_MCP_AGENTS=https://agent.example.com \
  npx a2a-mcp-skillmap
```

### Stdio, multiple agents (comma-separated)

```bash
A2A_MCP_AGENTS=https://agent-a.example.com,https://agent-b.example.com \
  npx a2a-mcp-skillmap
```

### HTTP with bearer inbound auth, all via env

```bash
A2A_MCP_AGENTS=https://agent.example.com \
A2A_MCP_TRANSPORT=http \
A2A_MCP_PORT=3000 \
A2A_MCP_INBOUND_AUTH_MODE=bearer \
A2A_MCP_INBOUND_AUTH_TOKEN=my-mcp-secret \
  npx a2a-mcp-skillmap
```

### HTTP with api-key inbound auth

```bash
A2A_MCP_AGENTS=https://agent.example.com \
A2A_MCP_TRANSPORT=http \
A2A_MCP_PORT=3000 \
A2A_MCP_INBOUND_AUTH_MODE=api_key \
A2A_MCP_INBOUND_AUTH_TOKEN=my-api-key \
A2A_MCP_INBOUND_AUTH_HEADER=X-API-Key \
  npx a2a-mcp-skillmap
```

### Retry + response-mode tuning

```bash
A2A_MCP_AGENTS=https://agent.example.com \
A2A_MCP_RESPONSE_MODE=raw \
A2A_MCP_RETRY_MAX_ATTEMPTS=5 \
A2A_MCP_RETRY_INITIAL_DELAY_MS=250 \
A2A_MCP_SYNC_BUDGET_MS=60000 \
  npx a2a-mcp-skillmap
```

> **Env vars can't carry per-agent auth.** If you need different tokens for different agents, use a config file (see next section).

---

## 3. Config file only

Config files are the only way to express per-agent credentials. All examples live in `examples/configs/`.

### Stdio + outbound bearer auth per agent

See [`configs/stdio-outbound-bearer.json`](configs/stdio-outbound-bearer.json):

```bash
npx a2a-mcp-skillmap --config examples/configs/stdio-outbound-bearer.json
```

### HTTP + inbound bearer + mixed outbound auth (most common prod shape)

See [`configs/http-full.json`](configs/http-full.json):

```bash
npx a2a-mcp-skillmap --config examples/configs/http-full.json
```

### HTTP + inbound api-key

See [`configs/http-apikey.json`](configs/http-apikey.json):

```bash
npx a2a-mcp-skillmap --config examples/configs/http-apikey.json
```

### Minimal file — just required fields

See [`configs/minimal.json`](configs/minimal.json):

```bash
npx a2a-mcp-skillmap --config examples/configs/minimal.json
```

### Multi-agent with per-agent retry + response-mode

See [`configs/tuned.json`](configs/tuned.json):

```bash
npx a2a-mcp-skillmap --config examples/configs/tuned.json
```

---

## 4. Mixed sources (the real-world pattern)

Start with a checked-in config for baseline topology, override per-environment via env vars, override per-run via CLI flags.

### Config file + env var for credentials

`bridge.json` commits the topology (agent URLs, transport, port). Env vars inject secrets:

```bash
A2A_MCP_INBOUND_AUTH_MODE=bearer \
A2A_MCP_INBOUND_AUTH_TOKEN="$INBOUND_TOKEN" \
  npx a2a-mcp-skillmap --config ./bridge.json
```

### Config file + CLI override for quick experiments

Base config says `responseMode: structured`; flip to `compact` for one run without editing:

```bash
npx a2a-mcp-skillmap --config ./bridge.json --response-mode compact
```

### Full three-tier merge

```bash
# file sets: agents, http.port=3000, responseMode=structured, logging.level=info
# env overrides: port=8080, log level
# CLI overrides: response mode for this invocation
A2A_MCP_PORT=8080 A2A_MCP_LOG_LEVEL=debug \
  npx a2a-mcp-skillmap --config ./bridge.json --response-mode raw
```

Result: agents from file, port from env, log level from env, response mode from CLI.

---

## 5. Programmatic (SDK)

When you need to embed the bridge in a larger Node service or customize a subsystem.

| File | Demonstrates |
|---|---|
| [`programmatic/minimal.ts`](programmatic/minimal.ts) | Smallest possible `createBridge` + stdio. |
| [`programmatic/http-auth.ts`](programmatic/http-auth.ts) | HTTP transport with both inbound and outbound auth. |
| [`programmatic/custom-projector.ts`](programmatic/custom-projector.ts) | Replace the default `ResponseProjector` with your own. |
| [`programmatic/custom-storage.ts`](programmatic/custom-storage.ts) | Replace the in-memory `TaskStore` with a custom backend. |
| [`programmatic/observability.ts`](programmatic/observability.ts) | Wire pino logger + telemetry listener + OpenTelemetry tracer. |

Run any of them with `tsx`:

```bash
npx tsx examples/programmatic/minimal.ts
```

---

## 6. Embedding in MCP clients

### Claude Desktop (macOS / Windows)

See [`mcp-clients/claude-desktop.json`](mcp-clients/claude-desktop.json). Drop the snippet into:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### VS Code MCP extension

See [`mcp-clients/vscode.json`](mcp-clients/vscode.json).

### Any networked MCP client (HTTP)

See [`mcp-clients/http-client.md`](mcp-clients/http-client.md) — covers how to target the bridge's `POST /mcp` endpoint with bearer auth.

---

## Validation

Every CLI / env / config path is validated by the same Zod schema. Mistakes fail fast with an exit code 2 and a structured error listing every bad field:

```bash
$ npx a2a-mcp-skillmap --config ./broken.json
Configuration error: Configuration validation failed: http.port: Number must be less than or equal to 65535
```

See [`docs/cli-reference.md`](../docs/cli-reference.md#exit-codes) for the full exit-code table.
