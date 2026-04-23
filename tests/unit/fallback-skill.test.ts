import { describe, it, expect } from 'vitest';
import {
  applyFallbackSkill,
  isFallbackSkill,
  FALLBACK_SKILL_ID,
  FALLBACK_SKILL_TAG,
} from '../../src/core/fallback-skill.js';
import type { ResolvedAgent } from '../../src/types/index.js';

function agent(
  skills: ResolvedAgent['skills'] = [],
  description = 'a demo agent',
): ResolvedAgent {
  return {
    url: 'https://a.com',
    id: 'dumb',
    name: 'dumb agent',
    version: '1.0.0',
    description,
    skills,
    rawCard: {},
  };
}

describe('applyFallbackSkill', () => {
  it('adds a message skill when skills is empty and mode is message', () => {
    const out = applyFallbackSkill(agent([]), 'message');
    expect(out.skills).toHaveLength(1);
    const skill = out.skills[0]!;
    expect(skill.id).toBe(FALLBACK_SKILL_ID);
    expect(skill.tags).toContain(FALLBACK_SKILL_TAG);
    expect(skill.description).toContain('dumb agent');
    expect(skill.description).toContain('a demo agent');
    expect(skill.inputSchema).toEqual({
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    });
  });

  it('omits description text when agent.description is blank', () => {
    const out = applyFallbackSkill(agent([], '   '), 'message');
    expect(out.skills[0]!.description).toContain('dumb agent');
    expect(out.skills[0]!.description).not.toContain('—');
  });

  it('returns the agent unchanged when mode is none', () => {
    const input = agent([]);
    expect(applyFallbackSkill(input, 'none')).toBe(input);
  });

  it('returns the agent unchanged when skills is non-empty', () => {
    const input = agent([
      {
        id: 's',
        name: 's',
        description: 'd',
        tags: [],
        inputModes: [],
        outputModes: [],
        agentUrl: 'https://a.com',
        agentId: 'dumb',
      },
    ]);
    expect(applyFallbackSkill(input, 'message')).toBe(input);
  });

  it('is pure (same input → structurally equal output)', () => {
    const a = applyFallbackSkill(agent([]), 'message');
    const b = applyFallbackSkill(agent([]), 'message');
    expect(a).toEqual(b);
  });
});

describe('isFallbackSkill', () => {
  it('identifies fallback skills by tag', () => {
    const out = applyFallbackSkill(agent([]), 'message');
    expect(isFallbackSkill(out.skills[0]!)).toBe(true);
  });

  it('returns false for ordinary skills', () => {
    expect(
      isFallbackSkill({
        id: 's',
        name: 's',
        description: 'd',
        tags: ['normal'],
        inputModes: [],
        outputModes: [],
        agentUrl: 'x',
        agentId: 'y',
      }),
    ).toBe(false);
  });
});
