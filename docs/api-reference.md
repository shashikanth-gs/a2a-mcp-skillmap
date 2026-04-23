# API Reference

All symbols are exported from the package root: `import { X } from 'a2a-mcp-skillmap'`.

## Factory

### `createBridge(config, options): BridgeInstance`

Constructs and wires a fully-configured bridge.

| Parameter | Type | Description |
|---|---|---|
| `config` | `BridgeConfig` | Validated output of `loadConfig()` or a hand-built config. |
| `options.dispatcher` | `A2ADispatcher` | **Required.** Translates tool calls into A2A requests. Use `DefaultA2ADispatcher` for production. |
| `options.projector` | `ResponseProjector?` | Override the default response projector. |
| `options.namingStrategy` | `ToolNamingStrategy?` | Override the default `{agentId}__{skillId}` scheme. |
| `options.registryStore` | `RegistryStore?` | Defaults to `MemoryRegistryStore`. |
| `options.taskStore` | `TaskStore?` | Defaults to `MemoryTaskStore`. |
| `options.agentResolver` | `AgentResolver?` | Override the card fetcher (useful for tests). |
| `options.authProviders` | `Map<string, AgentAuthProvider>?` | Explicit per-agent auth; auto-built from config if omitted. |
| `options.canceller` | `A2ACanceller?` | Forwards `task.cancel` to the remote agent. |

Returns a `BridgeInstance`:

```ts
interface BridgeInstance {
  readonly engine: BridgeEngine;
  start(): Promise<void>;
  stop(): Promise<void>;
}
```

## Configuration

### `loadConfig(sources?): BridgeConfig`

Merges CLI flags → env vars → file (highest precedence first) and validates against `BridgeConfigSchema`.

| Source | Key |
|---|---|
| CLI | `sources.cli: Partial<RawConfig>` |
| Env | `sources.env: Record<string, string>` |
| File | `sources.filePath: string` |

Throws `ConfigLoadError` with `code` in `{CONFIG_FILE_READ_ERROR, CONFIG_FILE_PARSE_ERROR, CONFIG_VALIDATION_ERROR}` and optional `details.fields[]`.

### `BridgeConfigSchema`

Zod schema for the full configuration. See [CLI reference](cli-reference.md) for every field.

### `parseConfig(json)` / `prettyPrintConfig(config)`

Serialize/deserialize config JSON. `parseConfig(prettyPrintConfig(c)) ≡ c` for every valid `c` (Property 12).

### `redactConfig(config): Record<string, unknown>`

Returns a deep copy of the config with credential values replaced by `[REDACTED]`. Safe for logging.

## Engine

### `BridgeEngine`

```ts
class BridgeEngine {
  initialize(): Promise<void>;       // resolve agents, generate tools
  shutdown(): Promise<void>;
  listTools(): ToolDeclaration[];
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}
```

Built-in task tools registered automatically:
- `task.status` — poll running task state
- `task.result` — fetch the completed result or "still running" indicator
- `task.cancel` — cancel a running task

## A2A layer

### `AgentResolver`

Fetches an agent card via `@a2a-js/sdk`, validates with Zod, and normalizes skills.

```ts
new AgentResolver({ fetcher?: AgentCardFetcher }).resolve(agentUrl, auth?): Promise<ResolvedAgent>
```

Throws `AgentResolutionError` with codes `AGENT_FETCH_FAILED | AGENT_CARD_EMPTY | AGENT_CARD_INVALID`.

### `SkillNormalizer` helpers

- `normalizeSkill(skill, agentMeta)` — throws `SkillNormalizationError` on invalid skill.
- `normalizeSkills(skills, agentMeta)` — partitions into `{ accepted, rejected }`.
- `jsonSchemaToZod(schema, skillId, path?)` — JSON Schema draft-07 subset → Zod.

### `AgentRegistry`

Manages agent configs, performs retry with backoff.

```ts
new AgentRegistry({ resolver, store?, retry?, scheduler?, authProviders? })
  .registerAgent(config)
  .resolveAll(): Promise<ResolvedAgent[]>
  .refreshAgent(url): Promise<ResolvedAgent>
  .getAgent(url): ResolvedAgent | undefined
  .getAllAgents(): ResolvedAgent[]
```

### `DefaultA2ADispatcher`

Backed by `@a2a-js/sdk`'s `A2AClient`. Caches clients by URL.

## Core components

### `ToolGenerator`

```ts
new ToolGenerator({ namingStrategy? })
  .generateTools(agents): ToolDeclaration[]
  .resolveToolSource(name): ToolSource | undefined
```

### `DefaultToolNamingStrategy`

Deterministic `{sanitize(agentId)}__{sanitize(skillId)}`, with hash-based truncation and namespacing on collision.

### `TaskManager`

Enforces `running → completed | failed | cancelled`; rejects invalid transitions with `TaskManagerError`.

### `InvocationRuntime`

Validates args against the declared Zod schema before dispatching (Property 6). Returns either `fast-path`, `long-path`, or `error`.

### `DefaultResponseProjector`

Shapes `CanonicalResult` → `CallToolResult` per `ResponseMode`:

- **`artifact`** (default) — multimodal unwrapping of A2A `parts[]` into native MCP content blocks: `text` parts → text blocks; `file` parts with inline image/audio bytes → `image` / `audio` blocks; `file` parts with a URI → `resource_link` blocks; `data` parts → stringified-JSON text blocks; inline non-media files degrade to `[file: <name>]` placeholders. Parts from all artifacts are flattened in order. No `structuredContent`.
- **`structured`** — full canonical envelope in `structuredContent` + one short text fallback in `content`.
- **`compact`** — one summary string ≤ 280 chars in `content`; no `structuredContent`.
- **`raw`** — every artifact's `data` verbatim in both `content` text and `structuredContent.raw`. Single artifact → data as-is; multi-artifact → JSON array of datas.

See the [operator guide](operator-guide.md#response-modes) for side-by-side JSON examples per mode, including a multimodal example.

## Transports

### `createStdioAdapter(engine, options?): StdioAdapter`

Wraps `BridgeEngine` in an `McpServer` + `StdioServerTransport`.

### `createHttpAdapter(engine, options): HttpAdapter`

Uses `StreamableHTTPServerTransport` on Express. Applies `inboundAuth` middleware before any MCP handling.

Throws `HttpPortUnavailableError` (code `PORT_UNAVAILABLE`) when the requested port is bound.

## Auth

### Inbound (HTTP transport)

| Class | Behavior |
|---|---|
| `NoopInboundAuth` | Accepts every request (mode `none`). |
| `BearerInboundAuth({ token })` | Requires `Authorization: Bearer <token>`. |
| `ApiKeyInboundAuth({ token, headerName? })` | Requires the configured header. |

`createInboundAuth(config)` throws `InboundAuthMisconfiguredError` on missing credentials.

### Outbound (to A2A agents)

| Class | Behavior |
|---|---|
| `NoopAgentAuth` | No-op. |
| `BearerAgentAuth(token)` | Attaches `Authorization: Bearer <token>`. |
| `ApiKeyAgentAuth(token, headerName?)` | Attaches the configured header. |

All expose `redactedDescription()` → safe log string (never leaks the token).

`createAgentAuth(config, agentUrl)` throws `OutboundAuthMisconfiguredError` on missing credentials.

## Observability

### `createLogger(options?): Logger`

Wraps `pino` with default credential redaction paths. Pass `level: 'debug' | ...` and an optional `destination` stream.

### `withCorrelation(logger, correlationId): Logger`

Returns a child logger that stamps every entry with the given `correlationId`.

### `Telemetry`

```ts
const tel = new Telemetry();
const unsubscribe = tel.subscribe((event) => { /* ... */ });
tel.emit({ kind: 'invocation.start', /* ... */ });
```

### `setOtelTracer(tracer)` / `withSpan(name, attrs, block)`

Optional OpenTelemetry span emission. When no tracer is registered, `withSpan` is a no-op that returns the block's result unchanged.

## Storage

| Interface | Default |
|---|---|
| `RegistryStore` | `MemoryRegistryStore` (Map-backed) |
| `TaskStore` | `MemoryTaskStore` (Map-backed) |

Both support `put / get / list / delete`. `TaskStore.list(filter?)` supports filtering by `state`, `agentUrl`, and `skillId`.

## Errors

Every surface-level error carries a `code` string you can switch on:

| Code | Source |
|---|---|
| `CONFIG_FILE_READ_ERROR` | `ConfigLoadError` |
| `CONFIG_FILE_PARSE_ERROR` | `ConfigLoadError` |
| `CONFIG_VALIDATION_ERROR` | `ConfigLoadError` |
| `AGENT_FETCH_FAILED` | `AgentResolutionError` / `AgentRegistryError` |
| `AGENT_CARD_INVALID` | `AgentResolutionError` |
| `AGENT_CARD_EMPTY` | `AgentResolutionError` |
| `AGENT_UNKNOWN` | `AgentRegistryError` |
| `SCHEMA_UNSUPPORTED` | `SkillNormalizationError` |
| `SKILL_INVALID` | `SkillNormalizationError` |
| `TASK_NOT_FOUND` | `TaskManagerError` |
| `TASK_INVALID_TRANSITION` | `TaskManagerError` |
| `TASK_ALREADY_TERMINAL` | `TaskManagerError` |
| `AUTH_MISCONFIGURED` | `InboundAuthMisconfiguredError` / `OutboundAuthMisconfiguredError` |
| `PORT_UNAVAILABLE` | `HttpPortUnavailableError` |

MCP tool-call errors (returned to the client) use the same `code` values plus:

- `VALIDATION_FAILED` — args did not match the declared input schema.
- `TOOL_NOT_FOUND` — unknown tool name.
- `A2A_PROTOCOL_ERROR` — dispatcher threw.
