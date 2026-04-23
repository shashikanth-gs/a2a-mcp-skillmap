/**
 * Feature: a2a-mcp-skillmap
 * - Property 8: Response Projector Mode Invariants — validates Requirements 6.2, 6.3, 6.4
 * - Property 9: Response Projector Schema Validity — validates Requirements 6.7, 18.5
 * - Property 10: Response Projector Determinism   — validates Requirements 11.2
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { DefaultResponseProjector } from '../../src/core/response-projector.js';
import type {
  CanonicalResult,
  ProjectionContext,
  ResponseMode,
} from '../../src/types/index.js';

// ---------------------------------------------------------------------------
// MCP CallToolResult schema — approximate but sufficient for Property 9
// ---------------------------------------------------------------------------

const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({
    type: z.literal('image'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('audio'),
    data: z.string(),
    mimeType: z.string(),
  }),
  z.object({
    type: z.literal('resource'),
    resource: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal('resource_link'),
    uri: z.string(),
    name: z.string(),
    mimeType: z.string().optional(),
  }),
]);

const callToolResultSchema = z.object({
  content: z.array(contentBlockSchema).min(1),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  isError: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const jsonPrimitiveArb = fc.oneof(
  fc.string({ maxLength: 20 }),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.boolean(),
  fc.constant(null),
);

const artifactArb = fc.record({
  type: fc.constantFrom('application/json', 'text/plain'),
  data: fc.oneof(
    jsonPrimitiveArb,
    fc.dictionary(fc.string({ maxLength: 8 }), jsonPrimitiveArb),
  ),
  name: fc.option(fc.string({ maxLength: 20 }), { nil: undefined }),
});

const canonicalResultArb: fc.Arbitrary<CanonicalResult> = fc.record({
  status: fc.constantFrom('success', 'error') as fc.Arbitrary<
    'success' | 'error'
  >,
  taskId: fc.option(fc.uuid(), { nil: undefined }),
  taskState: fc.option(
    fc.constantFrom('running', 'completed', 'failed', 'cancelled'),
    { nil: undefined },
  ) as fc.Arbitrary<
    'running' | 'completed' | 'failed' | 'cancelled' | undefined
  >,
  artifacts: fc.array(artifactArb, { maxLength: 3 }),
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

const modes: ResponseMode[] = ['structured', 'compact', 'artifact', 'raw'];

function makeContext(mode: ResponseMode): ProjectionContext {
  return { mode, toolName: 'test-tool', correlationId: 'corr-1' };
}

// ---------------------------------------------------------------------------
// Property 8: Mode invariants
// ---------------------------------------------------------------------------

describe('Property 8: Response Projector Mode Invariants', () => {
  const projector = new DefaultResponseProjector();

  it('structured mode carries structuredContent + non-empty text fallback', () => {
    fc.assert(
      fc.property(canonicalResultArb, (r) => {
        const out = projector.project(r, makeContext('structured'));
        expect(out.structuredContent).toBeDefined();
        expect(out.content.length).toBeGreaterThanOrEqual(1);
        const first = out.content[0]!;
        expect(first.type).toBe('text');
        expect((first as { text: string }).text.length).toBeGreaterThan(0);
      }),
      { numRuns: 100 },
    );
  });

  it('compact mode summary is ≤ 280 chars', () => {
    fc.assert(
      fc.property(canonicalResultArb, (r) => {
        const out = projector.project(r, makeContext('compact'));
        expect(out.content.length).toBeGreaterThanOrEqual(1);
        const first = out.content[0]!;
        expect(first.type).toBe('text');
        const text = (first as { text: string }).text;
        expect(text.length).toBeGreaterThan(0);
        expect(text.length).toBeLessThanOrEqual(280);
      }),
      { numRuns: 100 },
    );
  });

  it('raw mode preserves every artifact data byte-for-byte', () => {
    fc.assert(
      fc.property(canonicalResultArb, (r) => {
        const out = projector.project(r, makeContext('raw'));
        const first = out.content[0]!;
        expect(first.type).toBe('text');
        const payload: unknown =
          r.artifacts.length === 1
            ? r.artifacts[0]!.data
            : r.artifacts.map((a) => a.data);
        expect((first as { text: string }).text).toBe(JSON.stringify(payload));
        // structuredContent.raw carries the same payload for programmatic access.
        expect((out.structuredContent as { raw: unknown }).raw).toEqual(payload);
      }),
      { numRuns: 100 },
    );
  });

  it('artifact mode always produces at least one typed block and never leaks structuredContent', () => {
    fc.assert(
      fc.property(canonicalResultArb, (r) => {
        const out = projector.project(r, makeContext('artifact'));
        expect(out.content.length).toBeGreaterThanOrEqual(1);
        for (const block of out.content) {
          expect([
            'text',
            'image',
            'audio',
            'resource',
            'resource_link',
          ]).toContain(block.type);
        }
        expect(out.structuredContent).toBeUndefined();
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Schema validity
// ---------------------------------------------------------------------------

describe('Property 9: Response Projector Schema Validity', () => {
  const projector = new DefaultResponseProjector();

  it('every projected CallToolResult is schema-valid across all modes', () => {
    fc.assert(
      fc.property(canonicalResultArb, fc.constantFrom(...modes), (r, mode) => {
        const out = projector.project(r, makeContext(mode));
        const parsed = callToolResultSchema.safeParse(out);
        if (!parsed.success) {
          /* c8 ignore next */
          throw new Error(
            `Schema invalid for mode=${mode}: ${parsed.error.message}`,
          );
        }
        expect(parsed.success).toBe(true);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 10: Determinism
// ---------------------------------------------------------------------------

describe('Property 10: Response Projector Determinism', () => {
  const projector = new DefaultResponseProjector();

  it('projecting the same input twice yields byte-equivalent output', () => {
    fc.assert(
      fc.property(canonicalResultArb, fc.constantFrom(...modes), (r, mode) => {
        const a = projector.project(r, makeContext(mode));
        const b = projector.project(r, makeContext(mode));
        expect(JSON.stringify(a)).toBe(JSON.stringify(b));
      }),
      { numRuns: 100 },
    );
  });
});
