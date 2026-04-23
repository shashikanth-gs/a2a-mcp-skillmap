/**
 * TaskManager — tracks long-running A2A tasks, enforces the `BridgeTask` state
 * machine, and handles eviction of expired terminal tasks.
 *
 * State machine: `running → completed | failed | cancelled`. All other
 * transitions are rejected with `TaskManagerError` and preserve prior state.
 *
 * @module core/task-manager
 */

import { randomUUID } from 'node:crypto';
import type {
  BridgeTask,
  CanonicalError,
  CanonicalResult,
  TaskState,
  TaskStore,
} from '../types/index.js';
import { VALID_TRANSITIONS } from '../types/index.js';
import { MemoryTaskStore } from '../storage/memory-task-store.js';

// ---------------------------------------------------------------------------
// A2A cancel hook
// ---------------------------------------------------------------------------

/** Strategy that sends a cancel request to a remote A2A agent. */
export interface A2ACanceller {
  cancel(agentUrl: string, a2aTaskId: string): Promise<void>;
}

/** Clock abstraction for deterministic tests. */
export interface Clock {
  now(): number;
}

const SYSTEM_CLOCK: Clock = { now: () => Date.now() };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TaskManagerError extends Error {
  public readonly code:
    | 'TASK_NOT_FOUND'
    | 'TASK_INVALID_TRANSITION'
    | 'TASK_ALREADY_TERMINAL';
  public readonly taskId: string;

  constructor(
    message: string,
    code: TaskManagerError['code'],
    taskId: string,
  ) {
    super(message);
    this.name = 'TaskManagerError';
    this.code = code;
    this.taskId = taskId;
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface TaskManagerOptions {
  store?: TaskStore;
  retentionMs?: number; // default: 1 hour
  clock?: Clock;
  canceller?: A2ACanceller;
  uuid?: () => string;
}

export interface TaskUpdatePayload {
  newState: TaskState;
  result?: CanonicalResult;
  error?: CanonicalError;
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export class TaskManager {
  private readonly store: TaskStore;
  private readonly retentionMs: number;
  private readonly clock: Clock;
  private readonly canceller: A2ACanceller | undefined;
  private readonly genId: () => string;

  constructor(options: TaskManagerOptions = {}) {
    this.store = options.store ?? new MemoryTaskStore();
    this.retentionMs = options.retentionMs ?? 3_600_000;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.canceller = options.canceller;
    this.genId = options.uuid ?? (() => randomUUID());
  }

  createTask(a2aTaskId: string, agentUrl: string, skillId: string): BridgeTask {
    const now = this.clock.now();
    const task: BridgeTask = {
      taskId: this.genId(),
      a2aTaskId,
      agentUrl,
      skillId,
      state: 'running',
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(task);
    return task;
  }

  getTask(taskId: string): BridgeTask | undefined {
    return this.store.get(taskId);
  }

  /**
   * Apply a new state (and optional result/error) to an existing task.
   * Rejects invalid transitions; preserves the prior state on rejection.
   */
  updateTaskState(taskId: string, update: TaskUpdatePayload): BridgeTask {
    const prior = this.store.get(taskId);
    if (!prior) {
      throw new TaskManagerError(
        `Task ${taskId} not found`,
        'TASK_NOT_FOUND',
        taskId,
      );
    }
    if (!VALID_TRANSITIONS[prior.state].includes(update.newState)) {
      throw new TaskManagerError(
        `Invalid transition ${prior.state} → ${update.newState} for task ${taskId}`,
        'TASK_INVALID_TRANSITION',
        taskId,
      );
    }
    const next: BridgeTask = {
      ...prior,
      state: update.newState,
      updatedAt: this.clock.now(),
      ...(update.result !== undefined ? { result: update.result } : {}),
      ...(update.error !== undefined ? { error: update.error } : {}),
    };
    this.store.update(next);
    return next;
  }

  async cancelTask(taskId: string): Promise<BridgeTask> {
    const task = this.store.get(taskId);
    if (!task) {
      throw new TaskManagerError(
        `Task ${taskId} not found`,
        'TASK_NOT_FOUND',
        taskId,
      );
    }
    if (task.state !== 'running') {
      throw new TaskManagerError(
        `Task ${taskId} already terminal (${task.state})`,
        'TASK_ALREADY_TERMINAL',
        taskId,
      );
    }
    if (this.canceller) {
      await this.canceller.cancel(task.agentUrl, task.a2aTaskId);
    }
    return this.updateTaskState(taskId, { newState: 'cancelled' });
  }

  /** Remove terminal tasks older than the retention window. */
  evictExpired(): BridgeTask[] {
    const now = this.clock.now();
    const evicted: BridgeTask[] = [];
    for (const task of this.store.list()) {
      if (task.state === 'running') continue;
      if (now - task.updatedAt > this.retentionMs) {
        this.store.delete(task.taskId);
        evicted.push(task);
      }
    }
    return evicted;
  }

  listTasks(): BridgeTask[] {
    return this.store.list();
  }
}
