/**
 * Feature: a2a-mcp-skillmap, Property 14: Registry Store Round-Trip
 * Validates: Requirements 1.3
 *
 * For any ResolvedAgent, `put(url, agent)` followed by `get(url)` returns a
 * structurally equivalent agent.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { MemoryRegistryStore } from '../../src/storage/memory-registry-store.js';
import type { ResolvedAgent, ResolvedSkill } from '../../src/types/index.js';

const urlArb = fc
  .tuple(
    fc.constantFrom('https', 'http'),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}\.(com|io|net|example)$/),
  )
  .map(([s, h]) => `${s}://${h}`);

const skillArb: fc.Arbitrary<ResolvedSkill> = fc.record({
  id: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,30}$/),
  name: fc.string({ minLength: 1, maxLength: 40 }),
  description: fc.string({ maxLength: 100 }),
  tags: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 5 }),
  inputSchema: fc.constant(undefined),
  inputModes: fc.array(fc.constantFrom('application/json', 'text/plain'), {
    maxLength: 3,
  }),
  outputModes: fc.array(fc.constantFrom('application/json', 'text/plain'), {
    maxLength: 3,
  }),
  agentUrl: urlArb,
  agentId: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/),
});

const resolvedAgentArb: fc.Arbitrary<ResolvedAgent> = fc.record({
  url: urlArb,
  id: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/),
  name: fc.string({ minLength: 1, maxLength: 40 }),
  version: fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  description: fc.option(fc.string({ maxLength: 120 }), { nil: undefined }),
  skills: fc.array(skillArb, { maxLength: 5 }),
  rawCard: fc.constant({}),
});

describe('Property 14: Registry Store Round-Trip', () => {
  it('put then get returns a semantically equivalent ResolvedAgent', () => {
    fc.assert(
      fc.property(resolvedAgentArb, (agent) => {
        const store = new MemoryRegistryStore();
        store.put(agent.url, agent);
        expect(store.get(agent.url)).toEqual(agent);
      }),
      { numRuns: 100 },
    );
  });

  it('list contains all put agents', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(resolvedAgentArb, {
          selector: (a) => a.url,
          minLength: 1,
          maxLength: 10,
        }),
        (agents) => {
          const store = new MemoryRegistryStore();
          for (const a of agents) store.put(a.url, a);
          const listed = store.list();
          expect(listed).toHaveLength(agents.length);
          for (const a of agents) {
            expect(store.get(a.url)).toEqual(a);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('delete removes the entry', () => {
    fc.assert(
      fc.property(resolvedAgentArb, (agent) => {
        const store = new MemoryRegistryStore();
        store.put(agent.url, agent);
        store.delete(agent.url);
        expect(store.get(agent.url)).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});
