# Security

## Threat model

The bridge sits between an MCP client (trusted) and one or more A2A agents (partially-trusted external services). The primary security concerns are:

1. **Credential exposure** — bearer tokens / API keys must never leak to logs, telemetry, or error messages.
2. **Auth bypass** — inbound HTTP auth must reject unauthenticated requests before any MCP handling occurs.
3. **Supply-chain** — validated transitive dependencies only; no runtime code evaluation.
4. **Input validation** — tool arguments are Zod-validated before any outbound call (Property 6).

## Secret handling

- Credentials enter the system only via environment variables or configuration files. **Never via CLI flags** (to avoid shell history / `ps` leakage).
- All logging paths run credential values through pino's `redact` paths. The fixed redaction token is `[REDACTED]`.
- `redactConfig()` produces a safe-for-logging snapshot of any `BridgeConfig`.
- Auth providers' `redactedDescription()` methods return strings that never contain the underlying token (Property 11).

## Authentication scope

- **Inbound auth** is HTTP-only. The stdio transport has no authentication by design — the caller is a trusted local process.
- **Outbound auth** is per-agent. One agent's compromised credential does not affect the others.
- Constant-time comparison is used for bearer/API-key validation in `safeEqual()` to avoid timing oracles.

## Input validation

- Tool arguments are validated against the declared Zod schema before the A2A client is contacted. Invalid arguments return an MCP error with `VALIDATION_FAILED` code and never reach the remote agent.
- Agent cards are validated against `AgentCardShapeSchema` at startup; malformed cards cause the agent to be rejected.
- Skill input schemas (JSON Schema draft-07 subset) are converted to Zod at startup. Unsupported constructs cause the skill to be rejected (but other skills on the same agent continue).

## Denial of service

- Long-running tasks are tracked in-memory with a configurable retention window (`taskRetentionMs`, default 1 h). Terminal tasks are evicted on interval or on access.
- Agent card fetches retry with bounded `retry.maxAttempts` and exponential backoff — no unbounded retry loops.
- The HTTP transport uses Express's default 4 MB body limit.

## Vulnerability reporting

Please report security issues privately via GitHub's "Security Advisories" feature on the project repository. Do not file public issues for suspected vulnerabilities. We aim to acknowledge within one business day and to ship a patch release within seven days of confirmation for high-severity issues.
