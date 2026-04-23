/**
 * Feature: a2a-mcp-skillmap
 * - Property 1: Tool Name Determinism     — validates Requirements 2.2, 11.1, 11.3
 * - Property 2: Tool Name Collision Freedom — validates Requirements 2.3
 * - Property 3: Tool Name Format Conformance — validates Requirements 2.7
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  DefaultToolNamingStrategy,
  MAX_MCP_TOOL_NAME_LENGTH,
} from '../../src/core/tool-naming.js';

const strat = new DefaultToolNamingStrategy();

// ---------------------------------------------------------------------------
// Property 1: Determinism
// ---------------------------------------------------------------------------

describe('Property 1: Tool Name Determinism', () => {
  it('deriveName returns identical output on repeated calls', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (agentId, skillId) => {
        const a = strat.deriveName(agentId, skillId);
        const b = strat.deriveName(agentId, skillId);
        const c = strat.deriveName(agentId, skillId);
        expect(a).toBe(b);
        expect(b).toBe(c);
      }),
      { numRuns: 100 },
    );
  });

  it('deriveName is consistent across fresh strategy instances', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (agentId, skillId) => {
        const s1 = new DefaultToolNamingStrategy();
        const s2 = new DefaultToolNamingStrategy();
        expect(s1.deriveName(agentId, skillId)).toBe(
          s2.deriveName(agentId, skillId),
        );
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 2: Collision Freedom for pairs from distinct agents
// ---------------------------------------------------------------------------

describe('Property 2: Tool Name Collision Freedom', () => {
  it('unique (agentId, skillId) pairs from distinct agents yield unique names', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(
            fc.tuple(
              // agentId — drawn from a very restrictive alphabet so that
              // sanitization does not collapse distinct inputs into one.
              fc.stringMatching(/^[a-zA-Z0-9_-]{1,16}$/),
              fc.stringMatching(/^[a-zA-Z0-9_-]{1,16}$/),
            ),
            {
              selector: ([a, s]) => `${a}|${s}`,
              minLength: 2,
              maxLength: 20,
            },
          )
          .filter((pairs) => {
            // Require at least two pairs with distinct agentIds.
            const distinctAgents = new Set(pairs.map(([a]) => a));
            return distinctAgents.size >= 2;
          }),
        (pairs) => {
          const names = pairs.map(([a, s]) => strat.deriveName(a, s));
          expect(new Set(names).size).toBe(names.length);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 3: Format Conformance
// ---------------------------------------------------------------------------

describe('Property 3: Tool Name Format Conformance', () => {
  it('arbitrary strings produce names matching ^[a-zA-Z0-9_-]+$ within max length', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (agentId, skillId) => {
        const name = strat.deriveName(agentId, skillId);
        expect(name.length).toBeGreaterThan(0);
        expect(name.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
        expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
        expect(strat.isValid(name)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('handles edge cases: empty, unicode, very long strings', () => {
    const cases: Array<[string, string]> = [
      ['', ''],
      ['agent', ''],
      ['', 'skill'],
      ['émojí-🚀', 'skíll-🔧'],
      ['a'.repeat(200), 'b'.repeat(200)],
      ['a/b/c', 'd/e/f'],
      ['with spaces', 'also spaces'],
    ];
    for (const [a, s] of cases) {
      const name = strat.deriveName(a, s);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });
});
