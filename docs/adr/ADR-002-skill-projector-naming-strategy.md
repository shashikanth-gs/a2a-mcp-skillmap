# ADR-002: Skill Projector Naming Strategy

**Date:** 2025-01-15

**Status:** Accepted

## Context

Each A2A skill must be exposed as a distinct MCP tool with a deterministic, stable name. MCP tool names are constrained to the character set `[a-zA-Z0-9_-]` and have a maximum length limit. The bridge must handle:

- Multiple agents, each potentially declaring skills with overlapping identifiers.
- Agent and skill identifiers that may contain unicode, special characters, or be excessively long.
- The requirement that identical inputs produce identical tool names across runs, process instances, and operating systems (no randomness, no wall-clock time, no process-specific state).
- Collision resolution when two different (agentId, skillId) pairs would produce the same sanitized name.

A generic dispatch tool (e.g., a single `invoke` tool with agent/skill parameters) was considered but rejected because it prevents MCP clients from discovering and invoking skills as first-class tools with typed schemas.

## Decision

The default `ToolNamingStrategy` derives MCP tool names using the pattern `{agentId}__{skillId}` (double underscore separator) with the following rules:

1. **Sanitization**: All characters outside `[a-zA-Z0-9_-]` in both `agentId` and `skillId` are replaced with `_` (underscore).
2. **Truncation**: The resulting name is truncated to the MCP maximum tool name length. Truncation preserves the `agentId__` prefix and truncates the skill portion, ensuring the agent namespace remains identifiable.
3. **Collision resolution**: After sanitization and truncation, if two or more distinct (agentId, skillId) pairs produce the same tool name, the strategy prefixes the name with a deterministic hash-based namespace token derived from the full, unsanitized (agentId, skillId) pair. The hash is computed using a stable algorithm (e.g., a truncated SHA-256 hex digest) to guarantee cross-platform determinism.
4. **Validation**: The `isValid(name)` method checks that a candidate name matches `^[a-zA-Z0-9_-]+$` and does not exceed the MCP maximum tool name length.

The naming strategy is exposed as a pluggable `ToolNamingStrategy` interface, allowing integrators to register custom derivation rules via the SDK.

## Consequences

### Positive

- **Determinism**: Tool names are pure functions of (agentId, skillId) with no external state, satisfying the deterministic behavior requirement across runs and platforms.
- **Readability**: The `{agentId}__{skillId}` pattern is human-readable and makes it easy to identify which agent and skill a tool corresponds to.
- **MCP compliance**: Sanitization and truncation guarantee that all generated names conform to MCP tool-name constraints.
- **Collision safety**: The hash-based prefix provides a deterministic fallback when sanitization causes name collisions across different agents.
- **Extensibility**: The pluggable interface allows deployments with custom naming conventions (e.g., flat names, prefixed by environment) without modifying the core.

### Negative

- **Information loss**: Sanitization replaces non-ASCII characters with underscores, which may reduce readability for agents with unicode identifiers.
- **Truncation edge cases**: Very long agent or skill identifiers may produce truncated names that are harder to distinguish visually, though the hash prefix ensures uniqueness.
- **Double underscore convention**: The `__` separator is a convention that could conflict with agent or skill identifiers that naturally contain double underscores, though this is mitigated by the full-pair hash fallback.

### Mitigations

- Property-based tests (Properties 1, 2, 3) verify determinism, collision freedom, and format conformance across a wide range of inputs including unicode, empty strings, and very long strings.
- The `ToolGenerator` logs a structured warning when collision resolution is triggered, alerting operators to potential naming ambiguity.
