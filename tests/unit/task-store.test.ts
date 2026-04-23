import { describe, it, expect } from 'vitest';
import { MemoryTaskStore } from '../../src/storage/memory-task-store.js';
import type { BridgeTask } from '../../src/types/index.js';

function mkTask(overrides: Partial<BridgeTask> = {}): BridgeTask {
  return {
    taskId: overrides.taskId ?? 'id',
    a2aTaskId: 'a2a',
    agentUrl: 'https://a.com',
    skillId: 's',
    state: 'running',
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('MemoryTaskStore', () => {
  it('put + get round-trips', () => {
    const store = new MemoryTaskStore();
    const t = mkTask({ taskId: 'x' });
    store.put(t);
    expect(store.get('x')).toEqual(t);
  });

  it('update throws when task does not exist', () => {
    const store = new MemoryTaskStore();
    expect(() => store.update(mkTask({ taskId: 'none' }))).toThrow(
      /does not exist/,
    );
  });

  it('delete removes the entry', () => {
    const store = new MemoryTaskStore();
    const t = mkTask({ taskId: 'd' });
    store.put(t);
    store.delete('d');
    expect(store.get('d')).toBeUndefined();
  });

  it('list filters by state / agentUrl / skillId', () => {
    const store = new MemoryTaskStore();
    store.put(mkTask({ taskId: '1', state: 'running' }));
    store.put(
      mkTask({ taskId: '2', state: 'completed', agentUrl: 'https://b.com' }),
    );
    store.put(mkTask({ taskId: '3', state: 'failed', skillId: 'other' }));

    expect(store.list({ state: 'running' }).map((t) => t.taskId)).toEqual([
      '1',
    ]);
    expect(
      store.list({ agentUrl: 'https://b.com' }).map((t) => t.taskId),
    ).toEqual(['2']);
    expect(store.list({ skillId: 'other' }).map((t) => t.taskId)).toEqual([
      '3',
    ]);
    // No filter returns all.
    expect(store.list()).toHaveLength(3);
  });
});
