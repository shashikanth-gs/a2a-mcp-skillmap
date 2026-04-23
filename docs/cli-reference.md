# CLI Reference

All flags can also be supplied via environment variables or a JSON configuration file. Precedence is **CLI flag > env var > config file**.

## Flags

| Flag | Env var | Config key | Default | Notes |
|---|---|---|---|---|
| `--a2a-url <url>` | `A2A_MCP_AGENTS` | `agents[].url` | _required_ | Repeatable; env var is comma-separated. |
| `--transport <mode>` | `A2A_MCP_TRANSPORT` | `transport` | `stdio` | `stdio` \| `http` |
| `--port <n>` | `A2A_MCP_PORT` | `http.port` | `3000` | HTTP port (1–65535). |
| `--response-mode <mode>` | `A2A_MCP_RESPONSE_MODE` | `responseMode` | `artifact` | `artifact` \| `structured` \| `compact` \| `raw`. See [operator guide](operator-guide.md#response-modes) for examples. |
| `--fallback-tool <mode>` | `A2A_MCP_FALLBACK_TOOL` | `fallbackTool` | `message` | `none` \| `message`. Controls what happens when an agent card advertises zero skills. |
| `--config <path>` | — | — | — | Path to a JSON config file. |
| `--log-level <level>` | `A2A_MCP_LOG_LEVEL` | `logging.level` | `info` | `trace` \| `debug` \| `info` \| `warn` \| `error` \| `fatal` |

## Additional env vars

These have no direct CLI flag; set via env or config.

| Env var | Config key | Default |
|---|---|---|
| `A2A_MCP_SYNC_BUDGET_MS` | `syncBudgetMs` | `30000` |
| `A2A_MCP_TASK_RETENTION_MS` | `taskRetentionMs` | `3600000` |
| `A2A_MCP_RETRY_MAX_ATTEMPTS` | `retry.maxAttempts` | `3` |
| `A2A_MCP_RETRY_INITIAL_DELAY_MS` | `retry.initialDelayMs` | `500` |
| `A2A_MCP_INBOUND_AUTH_MODE` | `http.inboundAuth.mode` | `none` |
| `A2A_MCP_INBOUND_AUTH_TOKEN` | `http.inboundAuth.token` | — |
| `A2A_MCP_INBOUND_AUTH_HEADER` | `http.inboundAuth.headerName` | `X-API-Key` (for `api_key`) |

## Per-agent auth (config file only)

CLI flags cannot carry per-agent credentials. Set them in the file or via environment variables your deployment pipeline injects.

```json
{
  "agents": [
    {
      "url": "https://agent-a.example.com",
      "auth": { "mode": "bearer", "token": "…" }
    },
    {
      "url": "https://agent-b.example.com",
      "auth": { "mode": "api_key", "token": "…", "headerName": "X-Custom-Key" }
    }
  ]
}
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Graceful shutdown. |
| `1` | Unhandled fatal error. |
| `2` | Configuration error (invalid schema, missing agents, bad file). |
| `3` | HTTP port unavailable. |
