import { describe, it, expect } from 'vitest';
import { DefaultResponseProjector } from '../../src/core/response-projector.js';
import type {
  CanonicalResult,
  ProjectionContext,
} from '../../src/types/index.js';

const projector = new DefaultResponseProjector();

function ctx(
  mode: 'structured' | 'compact' | 'artifact' | 'raw',
): ProjectionContext {
  return { mode, toolName: 't', correlationId: 'c' };
}

const RESULT: CanonicalResult = {
  status: 'success',
  artifacts: [{ type: 'application/json', data: { k: 1 }, name: 'payload' }],
  metadata: {
    agentUrl: 'https://a.com',
    skillId: 's',
    durationMs: 10,
    correlationId: 'c',
  },
};

const TASK_RESULT: CanonicalResult = {
  status: 'success',
  taskId: 'task-123',
  taskState: 'running',
  artifacts: [],
  metadata: {
    agentUrl: 'https://a.com',
    skillId: 's',
    durationMs: 0,
    correlationId: 'c',
    a2aTaskId: 'a2a-1',
  },
};

describe('DefaultResponseProjector', () => {
  it('structured mode includes artifact + metadata', () => {
    const out = projector.project(RESULT, ctx('structured'));
    expect(out.structuredContent).toMatchObject({
      status: 'success',
      artifacts: [{ type: 'application/json', name: 'payload' }],
      metadata: { agentUrl: 'https://a.com' },
    });
  });

  it('compact mode mentions artifact count + skillId', () => {
    const out = projector.project(RESULT, ctx('compact'));
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('1 artifact');
    expect(text).toContain('s');
  });

  it('raw mode with a single artifact emits that artifact\'s data verbatim', () => {
    const out = projector.project(RESULT, ctx('raw'));
    const text = (out.content[0] as { text: string }).text;
    expect(text).toBe(JSON.stringify({ k: 1 }));
    expect((out.structuredContent as { raw: unknown }).raw).toEqual({ k: 1 });
  });

  it('raw mode with multiple artifacts emits the full array', () => {
    const multi: CanonicalResult = {
      ...RESULT,
      artifacts: [
        { type: 'application/json', data: { a: 1 } },
        { type: 'application/json', data: { b: 2 } },
      ],
    };
    const out = projector.project(multi, ctx('raw'));
    expect((out.content[0] as { text: string }).text).toBe(
      JSON.stringify([{ a: 1 }, { b: 2 }]),
    );
  });

  it('raw mode with no artifacts emits an empty array', () => {
    const empty: CanonicalResult = { ...RESULT, artifacts: [] };
    const out = projector.project(empty, ctx('raw'));
    expect((out.content[0] as { text: string }).text).toBe('[]');
  });

  it('raw mode preserves the full A2A envelope (message with parts)', () => {
    const a2aEnvelope: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            kind: 'message',
            role: 'agent',
            messageId: 'm-1',
            parts: [{ kind: 'text', text: '2026-04-24T00:00:00.000Z' }],
          },
        },
      ],
    };
    const out = projector.project(a2aEnvelope, ctx('raw'));
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('"kind":"message"');
    expect(text).toContain('"role":"agent"');
    expect(text).toContain('"parts"');
  });

  // -------------------------------------------------------------------------
  // artifact mode (multimodal)
  // -------------------------------------------------------------------------

  it('artifact mode extracts text parts as text blocks', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            kind: 'message',
            role: 'agent',
            parts: [{ kind: 'text', text: '2026-04-24T00:00:00.000Z' }],
          },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'text', text: '2026-04-24T00:00:00.000Z' },
    ]);
    expect(out.structuredContent).toBeUndefined();
  });

  it('artifact mode emits multiple text blocks for multiple text parts', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            parts: [
              { kind: 'text', text: 'line one' },
              { kind: 'text', text: 'line two' },
            ],
          },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
    ]);
  });

  it('artifact mode flattens parts across multiple artifacts in order', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: { parts: [{ kind: 'text', text: 'first' }] },
        },
        {
          type: 'application/json',
          data: { parts: [{ kind: 'text', text: 'second' }] },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'text', text: 'first' },
      { type: 'text', text: 'second' },
    ]);
  });

  it('artifact mode emits an image block for inline-bytes image files', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            parts: [
              {
                kind: 'file',
                file: { bytes: 'QkFTRTY0', mimeType: 'image/png', name: 'chart.png' },
              },
            ],
          },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'image', data: 'QkFTRTY0', mimeType: 'image/png' },
    ]);
  });

  it('artifact mode emits an audio block for inline-bytes audio files', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            parts: [
              {
                kind: 'file',
                file: { bytes: 'QkFTRTY0', mimeType: 'audio/mpeg' },
              },
            ],
          },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'audio', data: 'QkFTRTY0', mimeType: 'audio/mpeg' },
    ]);
  });

  it('artifact mode emits a resource_link for URI file parts', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            parts: [
              {
                kind: 'file',
                file: { uri: 'https://x/y.pdf', mimeType: 'application/pdf', name: 'report.pdf' },
              },
            ],
          },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      {
        type: 'resource_link',
        uri: 'https://x/y.pdf',
        name: 'report.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  });

  it('artifact mode degrades non-media inline files to a text placeholder', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            parts: [
              {
                kind: 'file',
                file: { bytes: 'QkFTRTY0', mimeType: 'application/pdf', name: 'report.pdf' },
              },
              { kind: 'file', file: { name: 'out.log' } },
            ],
          },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'text', text: '[file: report.pdf]' },
      { type: 'text', text: '[file: out.log]' },
    ]);
  });

  it('artifact mode emits a text block with stringified data for data parts', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [
        {
          type: 'application/json',
          data: {
            parts: [
              { kind: 'text', text: 'report:' },
              { kind: 'data', data: { score: 42 } },
            ],
          },
        },
      ],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'text', text: 'report:' },
      { type: 'text', text: '{"score":42}' },
    ]);
  });

  it('artifact mode passes through plain string payloads', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [{ type: 'text/plain', data: 'already text' }],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([{ type: 'text', text: 'already text' }]);
  });

  it('artifact mode falls back to JSON for payloads without parts', () => {
    const r: CanonicalResult = {
      ...RESULT,
      artifacts: [{ type: 'application/json', data: { unknown: 'shape' } }],
    };
    const out = projector.project(r, ctx('artifact'));
    expect(out.content).toEqual([
      { type: 'text', text: '{"unknown":"shape"}' },
    ]);
  });

  it('artifact mode emits an empty text block for zero-artifact results', () => {
    const empty: CanonicalResult = { ...RESULT, artifacts: [] };
    const out = projector.project(empty, ctx('artifact'));
    expect(out.content).toEqual([{ type: 'text', text: '' }]);
  });

  it('structured mode for task handles references task state', () => {
    const out = projector.project(TASK_RESULT, ctx('structured'));
    expect(out.structuredContent).toMatchObject({
      taskId: 'task-123',
      taskState: 'running',
    });
    const text = (out.content[0] as { text: string }).text;
    expect(text).toContain('task-123');
    expect(text).toContain('running');
  });

  it('compact mode for task handles is bounded at 280 chars', () => {
    const out = projector.project(TASK_RESULT, ctx('compact'));
    const text = (out.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(280);
    expect(text).toContain('task-123');
  });
});
