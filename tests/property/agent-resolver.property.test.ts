/**
 * Feature: a2a-mcp-skillmap, Property 15: Agent Card Normalization Preservation
 * Validates: Requirements 1.2
 *
 * For any valid A2A AgentCard, `AgentResolver.resolve()` preserves the card's
 * top-level identity fields and its skills' id/name/description/tags.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';

// ---------------------------------------------------------------------------
// Arbitrary card generators
// ---------------------------------------------------------------------------

const agentUrlArb = fc
  .tuple(
    fc.constantFrom('https', 'http'),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}\.(com|net|io|example)$/),
  )
  .map(([s, h]) => `${s}://${h}`);

const mimeArb = fc.constantFrom(
  'application/json',
  'text/plain',
  'application/xml',
);

const skillArb = fc.record({
  id: fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9_-]{0,20}$/),
  name: fc.string({ minLength: 1, maxLength: 40 }),
  description: fc.string({ maxLength: 120 }),
  tags: fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
    maxLength: 5,
  }),
  inputModes: fc.option(fc.array(mimeArb, { maxLength: 3 }), { nil: undefined }),
  outputModes: fc.option(fc.array(mimeArb, { maxLength: 3 }), { nil: undefined }),
});

const agentCardArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 40 }),
  description: fc.string({ maxLength: 120 }),
  version: fc.stringMatching(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  url: agentUrlArb,
  protocolVersion: fc.constantFrom('0.3.0', '1.0.0'),
  defaultInputModes: fc.array(mimeArb, { maxLength: 3 }),
  defaultOutputModes: fc.array(mimeArb, { maxLength: 3 }),
  skills: fc
    .uniqueArray(skillArb, {
      selector: (s) => s.id,
      minLength: 0,
      maxLength: 8,
    }),
});

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('Property 15: Agent Card Normalization Preservation', () => {
  it('preserves id, name, version, description, and skill count + core fields', () => {
    fc.assert(
      fc.asyncProperty(agentUrlArb, agentCardArb, async (url, card) => {
        const resolver = new AgentResolver({
          fetcher: async () => card,
        });
        const resolved = await resolver.resolve(url);

        expect(resolved.url).toBe(url);
        expect(resolved.name).toBe(card.name);
        expect(resolved.version).toBe(card.version);
        expect(resolved.description).toBe(card.description);
        expect(resolved.skills).toHaveLength(card.skills.length);

        for (let i = 0; i < card.skills.length; i++) {
          const src = card.skills[i]!;
          const dst = resolved.skills[i]!;
          expect(dst.id).toBe(src.id);
          expect(dst.name).toBe(src.name);
          expect(dst.description).toBe(src.description);
          expect(dst.tags).toEqual(src.tags);
        }
      }),
      { numRuns: 100 },
    );
  });
});
