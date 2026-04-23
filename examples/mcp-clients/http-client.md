# Targeting the bridge over HTTP

When the bridge runs with `--transport http`, every MCP request goes to `POST /mcp` on the configured port. This file shows the wire-level details so you can point any MCP client (or test tool) at it.

## 1. Start the bridge

```bash
npx a2a-mcp-skillmap --config ./examples/configs/http-full.json
```

`http-full.json` exposes port 3000 with bearer inbound auth (token: `replace-with-inbound-mcp-secret`).

## 2. Speak MCP over HTTP

Every request is JSON-RPC 2.0 inside a POST body. The bridge validates the bearer token before any MCP handling occurs.

### List tools

```bash
curl -sS -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer replace-with-inbound-mcp-secret' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq
```

### Call a tool

```bash
curl -sS -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer replace-with-inbound-mcp-secret' \
  -d '{
        "jsonrpc":"2.0",
        "id":2,
        "method":"tools/call",
        "params":{
          "name":"research-agent__search",
          "arguments":{"query":"quantum computing"}
        }
      }' | jq
```

### Poll a long-running task

```bash
curl -sS -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer replace-with-inbound-mcp-secret' \
  -d '{
        "jsonrpc":"2.0",
        "id":3,
        "method":"tools/call",
        "params":{"name":"task.status","arguments":{"taskId":"<bridge-task-uuid>"}}
      }' | jq
```

## 3. What a rejected request looks like

Without or with a wrong bearer token, the bridge returns HTTP `401` with a structured error body — **before** any MCP handling runs:

```json
{ "error": { "code": "AUTH_FAILED", "message": "Authentication required" } }
```

## 4. Using `api_key` mode instead

Swap `inboundAuth.mode` to `api_key`, set a `headerName` (default `X-API-Key`), and send the token in that header:

```bash
curl -sS -X POST http://localhost:3000/mcp \
  -H 'content-type: application/json' \
  -H 'X-API-Key: replace-with-mcp-api-key' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 5. Behind a reverse proxy (TLS)

The bridge itself speaks plain HTTP — terminate TLS at your reverse proxy (nginx, Caddy, AWS ALB). Forward `POST /mcp` unchanged. The inbound auth middleware runs against the forwarded `Authorization` / custom header just like in the direct case.

Reminder: inbound auth is only meaningful when the bridge is reachable over a network. The stdio transport has no authentication by design (the caller is a trusted local process).
