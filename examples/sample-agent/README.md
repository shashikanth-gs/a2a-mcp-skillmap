# Sample A2A Agent

A deterministic, no-LLM A2A agent you can run locally to drive the bridge end-to-end. It's not part of the main build; it's a stand-alone npm package under `examples/sample-agent/`.

## What it exposes

Three skills, each exercising a different A2A reply path:

| Skill | Reply path | What it does |
|---|---|---|
| `current_time` | Immediate `Message` (fast path) | Returns an ISO-8601 timestamp. No Task lifecycle. |
| `run_command` | `Task` → working → artifact → completed | Runs one of `date`, `uptime`, `whoami`, `hostname`, `pwd` via `execFile` and returns stdout. Blocking. |
| `slow_report` | Streaming `Task` with repeated working updates | Emits intermediate progress states, then the final artifact. |

### Safety

`run_command` uses a **strict allowlist**, no shell interpretation (`execFile`, not `exec`), and no user-supplied argv. You cannot pass a free-form command to this agent. If you want to extend it, change `SUPPORTED_COMMANDS` in `src/skills.ts` — don't accept user input.

## Run it

```bash
cd examples/sample-agent
npm install
npm start
```

You'll see:

```
sample-agent listening on http://127.0.0.1:4003
  agent card:   http://127.0.0.1:4003/.well-known/agent-card.json
  JSON-RPC:     http://127.0.0.1:4003/a2a/jsonrpc
  health:       http://127.0.0.1:4003/health
  skills:       current_time, run_command, slow_report
```

Environment overrides:
- `PORT` (default `4003`)
- `HOST` (default `127.0.0.1`; set to `0.0.0.0` for non-local access)

## Use it through the bridge

In another terminal, from the repo root:

```bash
npm run build   # once, if you haven't built the bridge yet
node ./dist/cli/index.js --a2a-url http://127.0.0.1:4003
```

The bridge resolves the agent card, projects three MCP tools — `sample-agent__current_time`, `sample-agent__run_command`, `sample-agent__slow_report` — plus the three built-in task tools (`task_status`, `task_result`, `task_cancel`).

## Wire it into VS Code

`.vscode/mcp.json`:

```json
{
  "servers": {
    "sample-agent": {
      "type": "stdio",
      "command": "node",
      "args": [
        "/absolute/path/to/a2a-mcp-skillmap/dist/cli/index.js",
        "--a2a-url",
        "http://127.0.0.1:4003"
      ]
    }
  }
}
```

Start the sample agent first, then reload the MCP server in VS Code.

## Quick tour you can try

From any MCP client attached to the bridge:

1. **Fast path** — call `sample-agent__current_time` with `{}`. Response comes back immediately as a canonical result; no Task is created.
2. **Blocking task** — call `sample-agent__run_command` with `{ "command": "uptime" }`. Response is the final artifact. If the task exceeds the bridge's sync budget, you get a `taskId` instead and you can poll with `task_status`.
3. **Streaming task** — call `sample-agent__slow_report` with `{}`. You'll get a `taskId` in the response. Call `task_status` a couple of times to see the `working` states, then `task_result` for the final report.
4. **Cancel** — start `sample-agent__slow_report`, then `task_cancel` with the returned `taskId`.

## Code layout

```
src/
├── skills.ts      — pure skill implementations + command allowlist
├── executor.ts    — routes messages, emits the right event shape per skill
└── server.ts      — Express wiring, agent card, JSON-RPC handler
```

No build step is needed — `tsx` runs the TypeScript directly. Type-checking is available via `npx tsc --noEmit`.
