/**
 * Feature: a2a-mcp-skillmap, Property 6: Input Validation Gate
 * Validates: Requirements 4.2, 4.3, 14.3
 *
 * For any MCP tool invocation:
 *   - invalid args → MCP error response + ZERO outbound A2A calls.
 *   - valid args → dispatcher is called exactly once.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { InvocationRuntime } from '../../src/core/invocation-runtime.js';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
  SkillLookup,
} from '../../src/core/invocation-runtime.js';
import { TaskManager } from '../../src/core/task-manager.js';
import type { ResolvedSkill, ToolSource } from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// Test fixture: a skill requiring { x: number, y: string }
// ---------------------------------------------------------------------------

const SKILL: ResolvedSkill = {
  id: 'test-skill',
  name: 'test',
  description: 'test',
  tags: [],
  inputModes: [],
  outputModes: [],
  agentUrl: 'https://a.example.com',
  agentId: 'agentA',
};
const SOURCE: ToolSource = {
  agentUrl: SKILL.agentUrl,
  agentId: SKILL.agentId,
  skillId: SKILL.id,
};
const INPUT_SCHEMA = z.object({ x: z.number(), y: z.string() });

/** Dispatcher that counts invocations and returns a canned final result. */
class CountingDispatcher implements A2ADispatcher {
  public calls = 0;
  async dispatch(): Promise<A2ADispatchResponse> {
    this.calls++;
    return { kind: 'final', artifacts: [{ type: 'application/json', data: {} }] };
  }
}

const LOOKUP: SkillLookup = {
  find: (s) =>
    s.agentUrl === SOURCE.agentUrl &&
    s.agentId === SOURCE.agentId &&
    s.skillId === SOURCE.skillId
      ? { skill: SKILL, inputSchema: INPUT_SCHEMA }
      : undefined,
  authFor: () => undefined,
};

const CONTEXT = {
  correlationId: 'corr-1',
  responseMode: 'structured' as const,
  syncBudgetMs: 5000,
};

// ---------------------------------------------------------------------------
// Property 6: Invalid args → validation error, zero dispatch calls.
// ---------------------------------------------------------------------------

const invalidArgsArb = fc.oneof(
  fc.record({ x: fc.string() }), // wrong type for x, missing y
  fc.record({ y: fc.integer() }), // wrong type for y, missing x
  fc.record({}),
  fc.record({ x: fc.integer(), y: fc.integer() }),
  fc.record({ x: fc.boolean(), y: fc.string() }),
);

describe('Property 6: Input Validation Gate', () => {
  it('invalid args never reach the dispatcher', () => {
    fc.assert(
      fc.asyncProperty(invalidArgsArb, async (args) => {
        const dispatcher = new CountingDispatcher();
        const runtime = new InvocationRuntime({
          dispatcher,
          lookup: LOOKUP,
          taskManager: new TaskManager(),
        });

        const outcome = await runtime.invoke(
          SOURCE,
          args as Record<string, unknown>,
          CONTEXT,
        );
        expect(outcome.kind).toBe('error');
        if (outcome.kind === 'error') {
          expect(outcome.error.code).toBe('VALIDATION_FAILED');
        }
        expect(dispatcher.calls).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it('valid args trigger exactly one dispatch call', () => {
    const validArgsArb = fc.record({
      x: fc.double({ noNaN: true, noDefaultInfinity: true }),
      y: fc.string(),
    });

    fc.assert(
      fc.asyncProperty(validArgsArb, async (args) => {
        const dispatcher = new CountingDispatcher();
        const runtime = new InvocationRuntime({
          dispatcher,
          lookup: LOOKUP,
          taskManager: new TaskManager(),
        });

        const outcome = await runtime.invoke(SOURCE, args, CONTEXT);
        expect(outcome.kind).toBe('fast-path');
        expect(dispatcher.calls).toBe(1);
      }),
      { numRuns: 100 },
    );
  });
});
