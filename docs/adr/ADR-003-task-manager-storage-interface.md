# ADR-003: Task Manager Storage Interface

**Date:** 2025-01-15

**Status:** Accepted

## Context

The bridge supports long-running A2A tasks that cannot complete within the configured synchronous budget. When a task enters the long path, the `TaskManager` creates a `BridgeTask` record and returns a task handle to the MCP client. The client then polls for status, retrieves results, or requests cancellation using dedicated MCP tools (`task.status`, `task.result`, `task.cancel`).

Task records must be stored reliably for the duration of the task lifecycle plus a configurable retention window. The default deployment scenario is a single-process bridge where in-memory storage is sufficient, but production deployments may require persistent or shared storage (e.g., Redis, a database) for durability or multi-instance coordination.

Hardcoding in-memory storage would prevent these production use cases without significant refactoring.

## Decision

The `TaskManager` depends on a `TaskStore` interface rather than a concrete storage implementation. The interface defines the following operations:

- `put(task: BridgeTask): void` — Store a new task record.
- `get(taskId: string): BridgeTask | undefined` — Retrieve a task by its bridge-assigned UUID.
- `update(task: BridgeTask): void` — Update an existing task record.
- `delete(taskId: string): void` — Remove a task record.
- `list(filter?: TaskFilter): BridgeTask[]` — List tasks matching an optional filter.

The default implementation is `MemoryTaskStore`, a `Map`-backed in-memory store that requires no external dependencies. Alternative backends can be registered programmatically via the SDK's `createBridge()` options.

Tasks follow a strict state machine with the following valid transitions:

- `running → completed`
- `running → failed`
- `running → cancelled`

All other transitions are rejected by the `TaskManager`, which preserves the prior state and logs a structured error. Terminal tasks (`completed`, `failed`, `cancelled`) are evicted after the configured retention window (`taskRetentionMs`, default 1 hour) to prevent unbounded memory growth.

## Consequences

### Positive

- **Pluggability**: Alternative storage backends (Redis, SQLite, PostgreSQL) can be provided without modifying the `TaskManager` or any core engine component.
- **Simplicity for default case**: The `MemoryTaskStore` is zero-dependency and suitable for single-process, development, and testing scenarios.
- **Testability**: The `TaskStore` interface can be easily mocked or stubbed in unit and property tests, enabling isolated testing of `TaskManager` logic.
- **State safety**: The strict state machine enforced by `TaskManager` (not the store) ensures that invalid transitions are caught regardless of the storage backend.
- **Eviction control**: The configurable retention window and eviction mechanism prevent unbounded memory growth in long-running deployments.

### Negative

- **Consistency guarantees vary**: The `MemoryTaskStore` provides no durability — a process crash loses all task records. Production backends must document their own consistency guarantees.
- **Interface surface area**: The `TaskStore` interface must be stable across versions, as third-party implementations depend on it. Changes require a major version bump.
- **Eviction responsibility**: Eviction logic lives in `TaskManager`, not in the store. Custom stores that implement their own TTL mechanisms may conflict with the `TaskManager`'s eviction.

### Mitigations

- Property-based tests (Property 7: Task State Lifecycle Monotonicity, Property 13: Task Record Serialization Round-Trip) verify state machine correctness and storage round-trip integrity.
- The operator guide documents that `MemoryTaskStore` is not suitable for production deployments requiring durability, and provides guidance on implementing custom backends.
- The `TaskStore` interface is intentionally minimal to reduce the likelihood of breaking changes.
