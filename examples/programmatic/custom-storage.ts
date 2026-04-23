/**
 * Swap the default MemoryTaskStore for a persistent backend.
 *
 * This example uses a contrived file-based store to keep the example
 * self-contained; in production you'd back this with Redis, SQLite, or
 * whatever durable store your deployment already runs.
 *
 * Run: `npx tsx examples/programmatic/custom-storage.ts`
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  createBridge,
  DefaultA2ADispatcher,
  createStdioAdapter,
  type BridgeConfig,
  type BridgeTask,
  type TaskFilter,
  type TaskStore,
} from '../../src/index.js';

/** Contrived file-backed TaskStore — illustrates the interface, not production. */
class FileTaskStore implements TaskStore {
  private readonly tasks = new Map<string, BridgeTask>();

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8')) as BridgeTask[];
      for (const t of data) this.tasks.set(t.taskId, t);
    }
  }

  private persist(): void {
    writeFileSync(this.path, JSON.stringify([...this.tasks.values()]));
  }

  put(task: BridgeTask): void {
    this.tasks.set(task.taskId, task);
    this.persist();
  }

  get(taskId: string): BridgeTask | undefined {
    return this.tasks.get(taskId);
  }

  update(task: BridgeTask): void {
    if (!this.tasks.has(task.taskId)) {
      throw new Error(`Task ${task.taskId} does not exist`);
    }
    this.tasks.set(task.taskId, task);
    this.persist();
  }

  delete(taskId: string): void {
    this.tasks.delete(taskId);
    this.persist();
  }

  list(filter?: TaskFilter): BridgeTask[] {
    const all = [...this.tasks.values()];
    if (!filter) return all;
    return all.filter((t) => {
      if (filter.state !== undefined && t.state !== filter.state) return false;
      if (filter.agentUrl !== undefined && t.agentUrl !== filter.agentUrl) return false;
      if (filter.skillId !== undefined && t.skillId !== filter.skillId) return false;
      return true;
    });
  }
}

const config: BridgeConfig = {
  agents: [{ url: 'https://agent.example.com', auth: { mode: 'none' } }],
  transport: 'stdio',
  responseMode: 'structured',
  syncBudgetMs: 30000,
  taskRetentionMs: 3_600_000,
  retry: { maxAttempts: 3, initialDelayMs: 500 },
  logging: { level: 'info' },
};

const bridge = createBridge(config, {
  dispatcher: new DefaultA2ADispatcher(),
  taskStore: new FileTaskStore('./tasks.json'),
});

await bridge.start();
const stdio = createStdioAdapter(bridge.engine);
await stdio.start();

process.on('SIGINT', async () => {
  await stdio.stop();
  await bridge.stop();
  process.exit(0);
});
