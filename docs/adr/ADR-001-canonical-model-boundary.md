# ADR-001: Canonical Model Boundary

**Date:** 2025-01-15

**Status:** Accepted

## Context

The a2a-mcp-skillmap bridge sits between two distinct protocol ecosystems: A2A (Agent-to-Agent) on the inbound side and MCP (Model Context Protocol) on the outbound side. Each protocol defines its own data shapes — A2A agent cards, A2A task responses, and MCP tool declarations / call results — with different schemas, naming conventions, and structural assumptions.

Without a clear internal representation, the core engine would need to handle raw A2A and MCP types throughout, leading to:

- Tight coupling between protocol-specific shapes and business logic.
- Duplicated validation scattered across multiple components.
- Fragile transformations that break when either protocol evolves.
- Difficulty testing core logic in isolation from protocol details.

The bridge must also support pluggable components (custom projectors, naming strategies, storage backends) that should not depend on the specifics of either external protocol.

## Decision

All external data — A2A agent cards, A2A responses, and MCP requests — is validated and normalized at ingress using Zod schemas before the core engine processes it. The bridge defines a canonical internal model consisting of:

- **ResolvedAgent**: Normalized representation of an A2A agent and its metadata.
- **ResolvedSkill**: Canonical skill representation extracted from an agent card.
- **CanonicalResult**: Unified invocation result carrying artifacts and metadata.
- **BridgeTask**: Internal task record tracking long-running A2A operations.

The ingress boundary works as follows:

1. **A2A agent cards** are fetched by `AgentResolver`, validated against the A2A agent-card schema with Zod, and normalized into `ResolvedAgent` / `ResolvedSkill` types via `SkillNormalizer`.
2. **A2A task responses** are received by `InvocationRuntime`, validated, and normalized into `CanonicalResult` before being passed to `ResponseProjector`.
3. **MCP tool call arguments** are validated against the declared Zod input schema before any outbound A2A call is dispatched.

Once data crosses the ingress boundary, all core components (`BridgeEngine`, `ToolGenerator`, `TaskManager`, `ResponseProjector`) operate exclusively on canonical types. Protocol-specific details are confined to the A2A layer (`src/a2a/`) and transport adapters (`src/mcp/`).

## Consequences

### Positive

- **Isolation**: Core engine logic is decoupled from both A2A and MCP protocol specifics. Changes to either protocol affect only the ingress/egress adapters.
- **Testability**: Core components can be tested with canonical types directly, without mocking protocol-level details.
- **Pluggability**: Custom projectors, naming strategies, and storage backends depend only on canonical interfaces, not on raw protocol shapes.
- **Validation consistency**: All external data passes through a single validation layer (Zod schemas), ensuring that invalid data never reaches the core engine.
- **Type safety**: TypeScript strict mode combined with explicit canonical types catches shape mismatches at compile time.

### Negative

- **Mapping overhead**: Every external interaction requires a transformation step (A2A → canonical, canonical → MCP), adding code and a small runtime cost.
- **Schema drift risk**: If A2A or MCP schemas evolve, the canonical model and its Zod validators must be updated in lockstep with the ingress adapters.
- **Duplication**: Some fields in the canonical model mirror their protocol counterparts closely, which may feel redundant for simple pass-through cases.

### Mitigations

- Property-based tests (Properties 5, 12, 13, 14, 15) verify round-trip correctness of all transformations, catching drift early.
- The canonical model is intentionally minimal — it captures only the fields the core engine needs, reducing the surface area for drift.
