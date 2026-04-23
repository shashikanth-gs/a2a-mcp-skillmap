/**
 * Feature: a2a-mcp-skillmap, Property 5: Schema Projection Equivalence
 * Validates: Requirements 2.4
 *
 * For any supported JSON Schema (draft-07 subset), the Zod schema produced by
 * `buildInputSchema` / `jsonSchemaToZod` accepts the same valid inputs and
 * rejects the same invalid inputs as the source schema.
 *
 * We encode a reference JSON Schema validator in TypeScript for the same
 * subset the normalizer supports and assert agreement on randomly-generated
 * schemas and values.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { jsonSchemaToZod } from '../../src/a2a/skill-normalizer.js';

// ---------------------------------------------------------------------------
// Reference validator (same subset as normalizer)
// ---------------------------------------------------------------------------

type JS = Record<string, unknown>;

function refValidate(schema: JS, value: unknown): boolean {
  if (Array.isArray(schema['enum'])) {
    return (schema['enum'] as unknown[]).some((e) => Object.is(e, value) || e === value);
  }
  const t = schema['type'];
  if (typeof t !== 'string') return true; // untyped accepts anything

  switch (t) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'null':
      return value === null;
    case 'array': {
      if (!Array.isArray(value)) return false;
      const items = schema['items'] as JS | undefined;
      if (!items) return true;
      return value.every((v) => refValidate(items, v));
    }
    case 'object': {
      if (
        typeof value !== 'object' ||
        value === null ||
        Array.isArray(value)
      )
        return false;
      const props = (schema['properties'] ?? {}) as Record<string, JS>;
      const required = Array.isArray(schema['required'])
        ? (schema['required'] as string[])
        : [];
      const v = value as Record<string, unknown>;
      for (const key of required) {
        if (!(key in v)) return false;
      }
      for (const [key, propSchema] of Object.entries(props)) {
        if (key in v && !refValidate(propSchema, v[key])) return false;
      }
      if (schema['additionalProperties'] === false) {
        for (const key of Object.keys(v)) {
          if (!(key in props)) return false;
        }
      }
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Arbitraries: primitive schemas + sample values (valid and invalid)
// ---------------------------------------------------------------------------

const primitiveSchemaArb: fc.Arbitrary<JS> = fc.oneof(
  fc.constant({ type: 'string' }),
  fc.constant({ type: 'number' }),
  fc.constant({ type: 'integer' }),
  fc.constant({ type: 'boolean' }),
  fc.constant({ type: 'null' }),
  fc.record({
    type: fc.constant('string'),
    enum: fc.uniqueArray(fc.string({ minLength: 1, maxLength: 8 }), {
      minLength: 1,
      maxLength: 4,
    }),
  }) as fc.Arbitrary<JS>,
);

const arraySchemaArb: fc.Arbitrary<JS> = primitiveSchemaArb.map((inner) => ({
  type: 'array',
  items: inner,
}));

const objectSchemaArb: fc.Arbitrary<JS> = fc
  .record({
    fields: fc.array(
      fc.tuple(
        fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
        primitiveSchemaArb,
      ),
      { minLength: 1, maxLength: 4 },
    ),
    additional: fc.boolean(),
    requiredRatio: fc.double({ min: 0, max: 1, noNaN: true }),
  })
  .map(({ fields, additional, requiredRatio }) => {
    const properties: Record<string, JS> = {};
    const required: string[] = [];
    const seen = new Set<string>();
    for (const [key, sub] of fields) {
      if (seen.has(key)) continue;
      seen.add(key);
      properties[key] = sub;
      // Keys with indices under requiredRatio are required.
      if (Math.random() < requiredRatio) required.push(key);
    }
    const schema: JS = { type: 'object', properties };
    if (required.length > 0) schema['required'] = required;
    if (additional) schema['additionalProperties'] = false;
    return schema;
  });

const supportedSchemaArb: fc.Arbitrary<JS> = fc.oneof(
  primitiveSchemaArb,
  arraySchemaArb,
  objectSchemaArb,
);

/** Generate a value compatible with a given JSON schema (valid instance). */
function validValueFor(schema: JS): fc.Arbitrary<unknown> {
  if (Array.isArray(schema['enum'])) {
    return fc.constantFrom(...(schema['enum'] as unknown[]));
  }
  const t = schema['type'] as string;
  switch (t) {
    case 'string':
      return fc.string({ maxLength: 20 });
    case 'number':
      return fc.double({ noNaN: true, noDefaultInfinity: true });
    case 'integer':
      return fc.integer();
    case 'boolean':
      return fc.boolean();
    case 'null':
      return fc.constant(null);
    case 'array': {
      const inner = schema['items'] as JS;
      return fc.array(validValueFor(inner), { maxLength: 4 });
    }
    case 'object': {
      const props = (schema['properties'] ?? {}) as Record<string, JS>;
      const required = new Set(
        Array.isArray(schema['required']) ? (schema['required'] as string[]) : [],
      );
      const shapeEntries = Object.entries(props);
      return fc
        .tuple(...shapeEntries.map(([, s]) => fc.option(validValueFor(s))))
        .map((vals) => {
          const obj: Record<string, unknown> = {};
          shapeEntries.forEach(([key, _s], idx) => {
            const v = vals[idx];
            if (required.has(key)) {
              obj[key] = v === null ? generateSample(props[key]!) : v;
            } else if (v !== null) {
              obj[key] = v;
            }
          });
          return obj;
        });
    }
    /* c8 ignore next 2 */
    default:
      return fc.constant(undefined);
  }
}

// Fallback sample when fc yields null for a required field.
function generateSample(schema: JS): unknown {
  const t = schema['type'];
  if (Array.isArray(schema['enum'])) return (schema['enum'] as unknown[])[0];
  switch (t) {
    case 'string':
      return 'x';
    case 'number':
      return 0;
    case 'integer':
      return 0;
    case 'boolean':
      return false;
    case 'null':
      return null;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return null;
  }
}

/** Generate likely-invalid values unrelated to the schema. */
const noiseValueArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 5 }),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.anything(), { maxLength: 3 }),
  fc.object({ maxKeys: 3 }),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Property 5: Schema Projection Equivalence', () => {
  it('Zod accepts values the reference validator accepts', () => {
    fc.assert(
      fc.property(supportedSchemaArb, (schema) => {
        const zod = jsonSchemaToZod(schema, 'test-skill');
        return fc.assert(
          fc.property(validValueFor(schema), (value) => {
            const refOk = refValidate(schema, value);
            const zodOk = zod.safeParse(value).success;
            // At minimum Zod should accept what the reference accepts.
            if (refOk) expect(zodOk).toBe(true);
          }),
          { numRuns: 20 },
        );
      }),
      { numRuns: 30 },
    );
  });

  it('Zod and reference validator agree on arbitrary noise values', () => {
    fc.assert(
      fc.property(supportedSchemaArb, noiseValueArb, (schema, value) => {
        const zod = jsonSchemaToZod(schema, 'test-skill');
        const refOk = refValidate(schema, value);
        const zodOk = zod.safeParse(value).success;
        // They must agree on accept/reject.
        expect(zodOk).toBe(refOk);
      }),
      { numRuns: 100 },
    );
  });
});
