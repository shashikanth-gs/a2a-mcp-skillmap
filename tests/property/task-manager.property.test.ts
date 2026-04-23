/**
 * Feature: a2a-mcp-skillmap, Property 7: Task State Lifecycle Monotonicity
 * Validates: Requirements 5.6, 5.7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  TaskManager,
  TaskManagerError,
} from '../../src/core/task-manager.js';
import type { TaskState } from '../../src/types/index.js';

const ALL_STATES: TaskState[] = ['running', 'completed', 'failed', 'cancelled'];
const VALID_FROM_RUNNING: TaskState[] = ['completed', 'failed', 'cancelled'];

describe('Property 7: Task State Lifecycle Monotonicity', () => {
  it('accepts only running→{completed,failed,cancelled}; rejects all other transitions', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATES),
        fc.constantFrom(...ALL_STATES),
        (from, to) => {
          // Seed a fresh TaskManager and drive a task into the target `from` state.
          const mgr = new TaskManager({
            uuid: () => 'seed-id',
          });
          mgr.createTask('a2a-1', 'https://a.com', 'skill-1');

          // Drive into `from` if not already running.
          if (from !== 'running') {
            // Only valid way to reach `from` is a running→from transition.
            if (!VALID_FROM_RUNNING.includes(from)) {
              // 'running' can't reach 'running' from anywhere; skip.
              return;
            }
            mgr.updateTaskState('seed-id', { newState: from });
          }

          const priorTask = mgr.getTask('seed-id')!;
          expect(priorTask.state).toBe(from);

          const shouldAccept =
            from === 'running' && VALID_FROM_RUNNING.includes(to);

          if (shouldAccept) {
            const result = mgr.updateTaskState('seed-id', { newState: to });
            expect(result.state).toBe(to);
          } else {
            expect(() =>
              mgr.updateTaskState('seed-id', { newState: to }),
            ).toThrow(TaskManagerError);
            // Prior state is preserved on rejection.
            expect(mgr.getTask('seed-id')!.state).toBe(from);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('rejects transitions with TASK_INVALID_TRANSITION code', () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_FROM_RUNNING), (terminal) => {
        const mgr = new TaskManager({ uuid: () => 'tid' });
        mgr.createTask('a2a', 'https://a.com', 's');
        mgr.updateTaskState('tid', { newState: terminal });

        // From terminal, any further transition is invalid.
        for (const next of ALL_STATES) {
          try {
            mgr.updateTaskState('tid', { newState: next });
            expect.fail(`should have rejected ${terminal} → ${next}`);
          } catch (err) {
            expect(err).toBeInstanceOf(TaskManagerError);
            expect((err as TaskManagerError).code).toBe(
              'TASK_INVALID_TRANSITION',
            );
          }
        }
      }),
      { numRuns: 30 },
    );
  });
});
