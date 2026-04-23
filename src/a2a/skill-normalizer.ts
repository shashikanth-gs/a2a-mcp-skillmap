/**
 * SkillNormalizer — convert A2A `AgentSkill` objects into canonical `ResolvedSkill`
 * representations and derive Zod schemas from optional JSON Schema input descriptors.
 *
 * Supported JSON Schema constructs (draft-07 subset):
 *   type: string | number | integer | boolean | null | object | array
 *   required (on object)
 *   properties (on object)
 *   items (on array; single schema form only)
 *   enum (on primitive types)
 *   additionalProperties (on object: boolean only)
 *
 * Unsupported constructs cause the skill to be rejected via `SkillNormalizationError`.
 *
 * @module a2a/skill-normalizer
 */

import { z, type ZodType } from 'zod';
import type { ResolvedSkill } from '../types/index.js';

// ---------------------------------------------------------------------------
// Structural input shape (loose; we validate as we go)
// ---------------------------------------------------------------------------

/** Minimal A2A skill shape we require for normalization. */
export interface A2AInputSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  inputModes?: string[];
  outputModes?: string[];
  inputSchema?: Record<string, unknown>;
}

/** Agent metadata needed to associate a skill with its parent agent. */
export interface A2AAgentMeta {
  agentUrl: string;
  agentId: string;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Raised when a skill's schema contains constructs the normalizer does not support. */
export class SkillNormalizationError extends Error {
  public readonly code: string;
  public readonly skillId: string;
  public readonly path: string;

  constructor(message: string, skillId: string, path: string, code = 'SCHEMA_UNSUPPORTED') {
    super(message);
    this.name = 'SkillNormalizationError';
    this.code = code;
    this.skillId = skillId;
    this.path = path;
  }
}

// ---------------------------------------------------------------------------
// JSON Schema → Zod conversion (draft-07 subset)
// ---------------------------------------------------------------------------

type JsonSchema = Record<string, unknown>;

const PRIMITIVE_TYPES = new Set([
  'string',
  'number',
  'integer',
  'boolean',
  'null',
  'object',
  'array',
]);

/**
 * Translate a JSON Schema (draft-07 subset) into a Zod type.
 *
 * @throws {SkillNormalizationError} on any unsupported construct.
 */
export function jsonSchemaToZod(
  schema: JsonSchema,
  skillId: string,
  path = '$',
): ZodType {
  if (schema === null || typeof schema !== 'object') {
    throw new SkillNormalizationError(
      `Schema at ${path} must be an object`,
      skillId,
      path,
    );
  }

  // Enum (primitive literal enumeration) — handled before type coercion.
  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'] as unknown[];
    if (values.length === 0) {
      throw new SkillNormalizationError(
        `enum at ${path} must be non-empty`,
        skillId,
        path,
      );
    }
    if (!values.every((v) => typeof v === 'string')) {
      // Only string enums are first-class; mixed-type enums fall through.
      return z.union(values.map((v) => z.literal(v as never)) as unknown as [
        ZodType,
        ZodType,
        ...ZodType[],
      ]);
    }
    return z.enum(values as [string, ...string[]]);
  }

  const type = schema['type'];
  if (typeof type !== 'string') {
    // Empty schema / untyped — accept anything.
    return z.unknown();
  }
  if (!PRIMITIVE_TYPES.has(type)) {
    throw new SkillNormalizationError(
      `Unsupported JSON Schema type "${type}" at ${path}`,
      skillId,
      path,
    );
  }

  switch (type) {
    case 'string':
      return z.string();
    case 'number':
      return z.number();
    case 'integer':
      return z.number().int();
    case 'boolean':
      return z.boolean();
    case 'null':
      return z.null();
    case 'array': {
      const items = schema['items'];
      if (items === undefined) return z.array(z.unknown());
      if (Array.isArray(items)) {
        throw new SkillNormalizationError(
          `tuple-style items at ${path} are not supported`,
          skillId,
          path,
        );
      }
      return z.array(jsonSchemaToZod(items as JsonSchema, skillId, `${path}.items`));
    }
    case 'object': {
      const properties = (schema['properties'] ?? {}) as Record<string, unknown>;
      const required = new Set(
        Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
      );
      const shape: Record<string, ZodType> = {};
      for (const [key, propSchema] of Object.entries(properties)) {
        const childPath = `${path}.properties.${key}`;
        const childZod = jsonSchemaToZod(propSchema as JsonSchema, skillId, childPath);
        shape[key] = required.has(key) ? childZod : childZod.optional();
      }
      const additional = schema['additionalProperties'];
      if (additional === false) return z.object(shape).strict();
      if (additional === true || additional === undefined) {
        return z.object(shape).passthrough();
      }
      throw new SkillNormalizationError(
        `additionalProperties as schema at ${path} is not supported (only boolean form)`,
        skillId,
        path,
      );
    }
    /* c8 ignore next 2 -- unreachable: PRIMITIVE_TYPES guards the switch */
    default:
      throw new SkillNormalizationError(
        `Unreachable type branch "${String(type)}" at ${path}`,
        skillId,
        path,
      );
  }
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Convert an A2A `AgentSkill` into a canonical `ResolvedSkill`. */
export function normalizeSkill(
  skill: A2AInputSkill,
  agent: A2AAgentMeta,
): ResolvedSkill {
  if (typeof skill.id !== 'string' || skill.id.length === 0) {
    throw new SkillNormalizationError(
      'Skill must have a non-empty id',
      String(skill.id ?? ''),
      '$.id',
      'SKILL_INVALID',
    );
  }
  if (typeof skill.name !== 'string' || skill.name.length === 0) {
    throw new SkillNormalizationError(
      'Skill must have a non-empty name',
      skill.id,
      '$.name',
      'SKILL_INVALID',
    );
  }

  // Probe inputSchema early so unsupported constructs fail fast (startup-time behavior).
  if (skill.inputSchema !== undefined) {
    jsonSchemaToZod(skill.inputSchema, skill.id, '$.inputSchema');
  }

  return {
    id: skill.id,
    name: skill.name,
    description: skill.description ?? '',
    tags: Array.isArray(skill.tags) ? [...skill.tags] : [],
    inputSchema: skill.inputSchema,
    inputModes: skill.inputModes ?? agent.defaultInputModes ?? [],
    outputModes: skill.outputModes ?? agent.defaultOutputModes ?? [],
    agentUrl: agent.agentUrl,
    agentId: agent.agentId,
  };
}

/**
 * Normalize an array of A2A skills, rejecting individual skills that fail
 * normalization instead of aborting the whole set.
 *
 * @returns Tuple of `{ accepted, rejected }` where rejected entries include
 *   the original skill and the reason.
 */
export function normalizeSkills(
  skills: A2AInputSkill[],
  agent: A2AAgentMeta,
): {
  accepted: ResolvedSkill[];
  rejected: Array<{ skill: A2AInputSkill; error: SkillNormalizationError }>;
} {
  const accepted: ResolvedSkill[] = [];
  const rejected: Array<{
    skill: A2AInputSkill;
    error: SkillNormalizationError;
  }> = [];

  for (const skill of skills) {
    try {
      accepted.push(normalizeSkill(skill, agent));
    } catch (err) {
      if (err instanceof SkillNormalizationError) {
        rejected.push({ skill, error: err });
        continue;
      }
      throw err;
    }
  }
  return { accepted, rejected };
}

/**
 * Build a Zod input-arg schema for a skill. Returns a permissive
 * `z.object({}).passthrough()` when the skill declares no inputSchema.
 */
export function buildInputSchema(skill: ResolvedSkill): ZodType {
  if (!skill.inputSchema) return z.object({}).passthrough();
  return jsonSchemaToZod(skill.inputSchema, skill.id, '$.inputSchema');
}
