import { describe, it, expect } from 'vitest';
import { TaskManager } from '../../src/core/task-manager.js';
import type { A2ACanceller } from '../../src/core/task-manager.js';

describe('TaskManager', () => {
  it('createTask assigns a UUID and starts in running state', () => {
    const mgr = new TaskManager({ uuid: () => 'uuid-1' });
    const t = mgr.createTask('a2a-1', 'https://a.com', 'skill');
    expect(t.taskId).toBe('uuid-1');
    expect(t.state).toBe('running');
    expect(t.a2aTaskId).toBe('a2a-1');
  });

  it('evictExpired removes terminal tasks beyond retention but keeps running ones', () => {
    let now = 0;
    const clock = {
      now: () => now,
    };
    const mgr = new TaskManager({
      retentionMs: 100,
      clock,
      uuid: (() => {
        let n = 0;
        return () => `uuid-${n++}`;
      })(),
    });
    now = 1000;
    mgr.createTask('a1', 'https://a.com', 's');
    mgr.createTask('a2', 'https://a.com', 's');
    mgr.updateTaskState('uuid-0', { newState: 'completed' });
    now = 2000; // 1000ms later — well past retention
    mgr.updateTaskState('uuid-1', { newState: 'completed' });
    now = 2050; // 50ms after uuid-1 terminal → still within retention
    const evicted = mgr.evictExpired();
    expect(evicted.map((t) => t.taskId)).toEqual(['uuid-0']);
    expect(mgr.getTask('uuid-0')).toBeUndefined();
    expect(mgr.getTask('uuid-1')?.state).toBe('completed');
  });

  it('cancelTask calls A2A canceller and transitions state', async () => {
    const calls: string[] = [];
    const canceller: A2ACanceller = {
      cancel: async (_url, id) => {
        calls.push(id);
      },
    };
    const mgr = new TaskManager({ canceller, uuid: () => 'uuid' });
    mgr.createTask('a2a', 'https://a.com', 's');
    const cancelled = await mgr.cancelTask('uuid');
    expect(cancelled.state).toBe('cancelled');
    expect(calls).toEqual(['a2a']);
  });

  it('cancelTask on terminal task throws TASK_ALREADY_TERMINAL', async () => {
    const mgr = new TaskManager({ uuid: () => 'uuid' });
    mgr.createTask('a2a', 'https://a.com', 's');
    mgr.updateTaskState('uuid', { newState: 'completed' });
    await expect(mgr.cancelTask('uuid')).rejects.toThrow();
  });
});
