import { describe, it, expect } from 'vitest';
import {
  SkillNormalizationError,
  jsonSchemaToZod,
  normalizeSkill,
  normalizeSkills,
} from '../../src/a2a/skill-normalizer.js';

const AGENT = { agentUrl: 'https://a.com', agentId: 'agent' };

describe('jsonSchemaToZod — supported constructs', () => {
  it('accepts a simple object with required + optional properties', () => {
    const zod = jsonSchemaToZod(
      {
        type: 'object',
        properties: {
          a: { type: 'string' },
          b: { type: 'number' },
        },
        required: ['a'],
      },
      'skill',
    );
    expect(zod.safeParse({ a: 'x' }).success).toBe(true);
    expect(zod.safeParse({ a: 'x', b: 1 }).success).toBe(true);
    expect(zod.safeParse({ b: 1 }).success).toBe(false);
  });

  it('accepts arrays', () => {
    const zod = jsonSchemaToZod(
      { type: 'array', items: { type: 'integer' } },
      'skill',
    );
    expect(zod.safeParse([1, 2, 3]).success).toBe(true);
    expect(zod.safeParse([1.5]).success).toBe(false);
  });

  it('rejects tuple-style arrays', () => {
    expect(() =>
      jsonSchemaToZod(
        { type: 'array', items: [{ type: 'string' }, { type: 'number' }] },
        'skill',
      ),
    ).toThrow(SkillNormalizationError);
  });

  it('rejects unsupported type keywords', () => {
    expect(() =>
      jsonSchemaToZod({ type: 'bogus' }, 'skill'),
    ).toThrow(SkillNormalizationError);
  });

  it('string enum produces a Zod enum', () => {
    const zod = jsonSchemaToZod(
      { type: 'string', enum: ['a', 'b'] },
      'skill',
    );
    expect(zod.safeParse('a').success).toBe(true);
    expect(zod.safeParse('c').success).toBe(false);
  });

  it('additionalProperties=false enforces strict objects', () => {
    const zod = jsonSchemaToZod(
      {
        type: 'object',
        properties: { a: { type: 'string' } },
        additionalProperties: false,
      },
      'skill',
    );
    expect(zod.safeParse({ a: 'x' }).success).toBe(true);
    expect(zod.safeParse({ a: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('normalizeSkill', () => {
  it('normalizes a valid skill and preserves identity fields', () => {
    const resolved = normalizeSkill(
      {
        id: 'echo',
        name: 'Echo',
        description: 'Echoes input',
        tags: ['util'],
        inputModes: ['application/json'],
      },
      AGENT,
    );
    expect(resolved.id).toBe('echo');
    expect(resolved.name).toBe('Echo');
    expect(resolved.tags).toEqual(['util']);
    expect(resolved.inputModes).toEqual(['application/json']);
  });

  it('rejects skills missing required fields', () => {
    expect(() =>
      normalizeSkill({ id: '', name: 'x' } as never, AGENT),
    ).toThrow(SkillNormalizationError);
    expect(() =>
      normalizeSkill({ id: 's', name: '' } as never, AGENT),
    ).toThrow(SkillNormalizationError);
  });
});

describe('normalizeSkills', () => {
  it('splits accepted and rejected skills', () => {
    const { accepted, rejected } = normalizeSkills(
      [
        { id: 'ok', name: 'ok' },
        {
          id: 'bad',
          name: 'bad',
          inputSchema: { type: 'object', properties: { x: { type: 'bogus' } } },
        },
      ],
      AGENT,
    );
    expect(accepted).toHaveLength(1);
    expect(accepted[0]!.id).toBe('ok');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.error.code).toBe('SCHEMA_UNSUPPORTED');
  });
});
