/**
 * Feature: a2a-mcp-skillmap, Property 13: Task Record Serialization Round-Trip
 * Validates: Requirements 18.3, 18.4
 *
 * JSON-serialize and deserialize a BridgeTask; all fields are preserved.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  BridgeTask,
  CanonicalError,
  CanonicalResult,
  TaskState,
} from '../../src/types/index.js';
import { MemoryTaskStore } from '../../src/storage/memory-task-store.js';

const taskStateArb: fc.Arbitrary<TaskState> = fc.constantFrom(
  'running',
  'completed',
  'failed',
  'cancelled',
);

const canonicalResultArb: fc.Arbitrary<CanonicalResult> = fc.record({
  status: fc.constantFrom('success', 'error') as fc.Arbitrary<
    'success' | 'error'
  >,
  artifacts: fc.array(
    fc.record({
      type: fc.constantFrom('application/json', 'text/plain'),
      data: fc.oneof(
        fc.string({ maxLength: 20 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.boolean(),
        fc.constant(null),
      ),
      name: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
    }),
    { maxLength: 3 },
  ),
  metadata: fc.record({
    agentUrl: fc.constantFrom('https://a.com', 'https://b.io'),
    skillId: fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/),
    durationMs: fc.integer({ min: 0, max: 60_000 }),
    correlationId: fc.stringMatching(/^[A-Za-z0-9-]{8,36}$/),
    a2aTaskId: fc.option(fc.string({ minLength: 1, maxLength: 20 }), {
      nil: undefined,
    }),
  }),
});

const canonicalErrorArb: fc.Arbitrary<CanonicalError> = fc.record({
  code: fc.stringMatching(/^[A-Z_]{3,20}$/),
  message: fc.string({ maxLength: 80 }),
  correlationId: fc.stringMatching(/^[A-Za-z0-9-]{8,36}$/),
  details: fc.option(
    fc.dictionary(
      fc.string({ maxLength: 10 }),
      fc.oneof(
        fc.string({ maxLength: 10 }),
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.boolean(),
        fc.constant(null),
      ),
    ),
    { nil: undefined },
  ),
});

const bridgeTaskArb: fc.Arbitrary<BridgeTask> = fc
  .record({
    taskId: fc.uuid(),
    a2aTaskId: fc.string({ minLength: 1, maxLength: 32 }),
    agentUrl: fc.constantFrom('https://a.com', 'https://b.io'),
    skillId: fc.stringMatching(/^[a-z][a-z0-9_-]{0,10}$/),
    state: taskStateArb,
    createdAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    updatedAt: fc.integer({ min: 0, max: 2_000_000_000_000 }),
    result: fc.option(canonicalResultArb, { nil: undefined }),
    error: fc.option(canonicalErrorArb, { nil: undefined }),
  })
  .map((t) => {
    const task: BridgeTask = {
      taskId: t.taskId,
      a2aTaskId: t.a2aTaskId,
      agentUrl: t.agentUrl,
      skillId: t.skillId,
      state: t.state,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
    if (t.result !== undefined) task.result = t.result;
    if (t.error !== undefined) task.error = t.error;
    return task;
  });

describe('Property 13: Task Record Serialization Round-Trip', () => {
  it('JSON serialize → parse preserves every field', () => {
    fc.assert(
      fc.property(bridgeTaskArb, (task) => {
        const roundTripped = JSON.parse(JSON.stringify(task)) as BridgeTask;
        expect(roundTripped).toEqual(task);
      }),
      { numRuns: 100 },
    );
  });

  it('MemoryTaskStore.put then get preserves every field', () => {
    fc.assert(
      fc.property(bridgeTaskArb, (task) => {
        const store = new MemoryTaskStore();
        store.put(task);
        expect(store.get(task.taskId)).toEqual(task);
      }),
      { numRuns: 100 },
    );
  });
});
