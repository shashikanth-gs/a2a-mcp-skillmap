/**
 * Feature: a2a-mcp-skillmap, Property 4: Tool Generation Completeness and Traceability
 * Validates: Requirements 2.1, 2.5, 4.1, 1.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ToolGenerator } from '../../src/core/tool-generator.js';
import type { ResolvedAgent, ResolvedSkill } from '../../src/types/index.js';

const urlArb = fc
  .tuple(
    fc.constantFrom('https', 'http'),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}\.(com|io|net|example)$/),
  )
  .map(([s, h]) => `${s}://${h}`);

const idArb = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/);

const skillArb = (agentUrl: string, agentId: string): fc.Arbitrary<ResolvedSkill> =>
  fc.record({
    id: idArb,
    name: fc.string({ minLength: 1, maxLength: 30 }),
    description: fc.string({ maxLength: 60 }),
    tags: fc.array(fc.string({ minLength: 1, maxLength: 10 }), {
      maxLength: 3,
    }),
    inputSchema: fc.constant(undefined),
    inputModes: fc.constant([]),
    outputModes: fc.constant([]),
    agentUrl: fc.constant(agentUrl),
    agentId: fc.constant(agentId),
  });

const agentArb: fc.Arbitrary<ResolvedAgent> = fc
  .tuple(urlArb, idArb)
  .chain(([url, id]) =>
    fc
      .uniqueArray(skillArb(url, id), {
        selector: (s) => s.id,
        minLength: 0,
        maxLength: 5,
      })
      .map(
        (skills): ResolvedAgent => ({
          url,
          id,
          name: `agent-${id}`,
          version: '1.0.0',
          description: 'test agent',
          skills,
          rawCard: {},
        }),
      ),
  );

describe('Property 4: Tool Generation Completeness and Traceability', () => {
  it('produces exactly one ToolDeclaration per ResolvedSkill', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(agentArb, {
          selector: (a) => a.url,
          minLength: 0,
          maxLength: 5,
        }),
        (agents) => {
          const gen = new ToolGenerator();
          const decls = gen.generateTools(agents);
          const totalSkills = agents.reduce(
            (acc, a) => acc + a.skills.length,
            0,
          );
          expect(decls).toHaveLength(totalSkills);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('each declaration is resolvable back to its source', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(agentArb, {
          selector: (a) => a.url,
          minLength: 1,
          maxLength: 5,
        }),
        (agents) => {
          const gen = new ToolGenerator();
          const decls = gen.generateTools(agents);

          for (const d of decls) {
            const src = gen.resolveToolSource(d.name);
            expect(src).toBeDefined();
            expect(src!.agentUrl).toBe(d.metadata.agentUrl);
            expect(src!.agentId).toBe(d.metadata.agentId);
            expect(src!.skillId).toBe(d.metadata.skillId);
          }

          // Every skill across every agent maps to some declaration.
          for (const a of agents) {
            for (const s of a.skills) {
              const match = decls.find(
                (d) =>
                  d.metadata.agentUrl === a.url &&
                  d.metadata.agentId === a.id &&
                  d.metadata.skillId === s.id,
              );
              expect(match).toBeDefined();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('tool names are unique across the generated set', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(agentArb, {
          selector: (a) => a.url,
          minLength: 1,
          maxLength: 5,
        }),
        (agents) => {
          const gen = new ToolGenerator();
          const decls = gen.generateTools(agents);
          const names = decls.map((d) => d.name);
          expect(new Set(names).size).toBe(names.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});
