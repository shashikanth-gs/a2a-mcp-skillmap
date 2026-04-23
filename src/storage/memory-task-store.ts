/**
 * In-memory `Map`-backed implementation of `TaskStore`.
 *
 * @module storage/memory-task-store
 */

import type { BridgeTask, TaskFilter, TaskStore } from '../types/index.js';

export class MemoryTaskStore implements TaskStore {
  private readonly store = new Map<string, BridgeTask>();

  put(task: BridgeTask): void {
    this.store.set(task.taskId, task);
  }

  get(taskId: string): BridgeTask | undefined {
    return this.store.get(taskId);
  }

  update(task: BridgeTask): void {
    if (!this.store.has(task.taskId)) {
      throw new Error(`Task ${task.taskId} does not exist`);
    }
    this.store.set(task.taskId, task);
  }

  delete(taskId: string): void {
    this.store.delete(taskId);
  }

  list(filter?: TaskFilter): BridgeTask[] {
    const all = Array.from(this.store.values());
    if (!filter) return all;
    return all.filter((t) => {
      if (filter.state !== undefined && t.state !== filter.state) return false;
      if (filter.agentUrl !== undefined && t.agentUrl !== filter.agentUrl)
        return false;
      if (filter.skillId !== undefined && t.skillId !== filter.skillId)
        return false;
      return true;
    });
  }
}
