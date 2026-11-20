/**
 * Trace-context forwarding: strict parsing, carrier selection (`_meta` then
 * HTTP header), the dispatcher's outgoing metadata, and the optional CLIENT span.
 */

import { describe, it, expect, afterEach } from 'vitest';
import type { A2AClient } from '@a2a-js/sdk/client';
import { DefaultA2ADispatcher } from '../../src/a2a/dispatcher.js';
import {
  parseTraceparent,
  sanitizeTracestate,
  extractTraceContext,
  sanitizePropagatedMetadata,
  runWithInboundTrace,
  currentInboundTrace,
  currentOutboundTrace,
} from '../../src/core/trace-context.js';
import { setOtelTracer, setOtelApi, startClientSpan } from '../../src/core/telemetry.js';

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TRACE = '0af7651916cd43dd8448eb211c80319c';
const SPAN = 'b7ad6b7169203331';

afterEach(() => {
  setOtelTracer(undefined);
  setOtelApi(undefined);
});

describe('parseTraceparent', () => {
  it('accepts a valid version 00 header', () => {
    expect(parseTraceparent(TP)).toEqual({ version: '00', traceId: TRACE, spanId: SPAN, traceFlags: 1 });
  });
  it('reads an unsampled flag', () => {
    expect(parseTraceparent(TP.replace(/-01$/, '-00'))?.traceFlags).toBe(0);
  });
  it.each([
    ['version ff', 'ff-' + TP.slice(3)],
    ['zero trace id', `00-${'0'.repeat(32)}-${SPAN}-01`],
    ['zero span id', `00-${TRACE}-${'0'.repeat(16)}-01`],
    ['upper case', TP.toUpperCase()],
    ['too short', TP.slice(0, 54)],
    ['extra field on version 00', TP + '-extra'],
    ['not hex', `00-${'z'.repeat(32)}-${SPAN}-01`],
    ['empty', ''],
    ['not a string', 42],
    ['huge', 'x'.repeat(10_000)],
  ])('rejects %s', (_l, v) => {
    expect(parseTraceparent(v)).toBeUndefined();
  });
  it('accepts a higher version with trailing fields', () => {
    expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-future`)?.traceId).toBe(TRACE);
  });
});

describe('sanitizeTracestate', () => {
  it('keeps a valid value', () => {
    expect(sanitizeTracestate('vendor=opaque,rojo=00f067aa0ba902b7')).toBe('vendor=opaque,rojo=00f067aa0ba902b7');
  });
  it.each([
    ['33 members', Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(',')],
    ['too long', 'a=' + 'x'.repeat(600)],
    ['malformed', 'no-equals'],
    ['empty', ''],
  ])('drops %s', (_l, v) => {
    expect(sanitizeTracestate(v)).toBeUndefined();
  });
});

describe('extractTraceContext', () => {
  it('reads _meta (Copilot)', () => {
    expect(extractTraceContext({ meta: { traceparent: TP, tracestate: 'v=1' } })).toEqual({ traceparent: TP, tracestate: 'v=1' });
  });
  it('reads the HTTP header (Claude Code)', () => {
    expect(extractTraceContext({ headers: { traceparent: TP } })).toEqual({ traceparent: TP });
  });
  it('prefers _meta over the header', () => {
    const other = `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`;
    expect(extractTraceContext({ meta: { traceparent: TP }, headers: { traceparent: other } })?.traceparent).toBe(TP);
  });
  it('falls through an invalid _meta to a valid header', () => {
    expect(extractTraceContext({ meta: { traceparent: 'garbage' }, headers: { traceparent: TP } })?.traceparent).toBe(TP);
  });
  it('rejects a repeated header', () => {
    expect(extractTraceContext({ headers: { traceparent: [TP, TP] } })).toBeUndefined();
  });
  it('drops an invalid tracestate but keeps the traceparent', () => {
    expect(extractTraceContext({ meta: { traceparent: TP, tracestate: 'bad' } })).toEqual({ traceparent: TP });
  });
  it('is undefined with nothing', () => {
    expect(extractTraceContext({})).toBeUndefined();
    expect(extractTraceContext({ meta: {}, headers: {} })).toBeUndefined();
  });
});

describe('sanitizePropagatedMetadata', () => {
  it('keeps ordinary values, drops bad keys, redacts secret-looking keys', () => {
    expect(sanitizePropagatedMetadata({ tenant: 'acme', 'bad key': 1, apiKey: 'sk-1', Authorization: 'Bearer x' })).toEqual({
      tenant: 'acme',
      apiKey: '[redacted]',
      Authorization: '[redacted]',
    });
  });
  it('caps keys and size', () => {
    const many = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
    expect(Object.keys(sanitizePropagatedMetadata(many)!)).toHaveLength(64);
    expect(sanitizePropagatedMetadata({ a: 1, huge: 'x'.repeat(9000), b: 2 })).toEqual({ a: 1, b: 2 });
  });
  it.each([[undefined], [null], ['s'], [[1]], [{}]])('is undefined for %j', (v) => {
    expect(sanitizePropagatedMetadata(v)).toBeUndefined();
  });
});

describe('async context', () => {
  it('exposes the inbound context only inside the run', async () => {
    expect(currentInboundTrace()).toBeUndefined();
    await runWithInboundTrace({ traceparent: TP }, async () => {
      await Promise.resolve();
      expect(currentInboundTrace()?.traceparent).toBe(TP);
    });
    expect(currentInboundTrace()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function capturingClient() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sent: Array<Record<string, any>> = [];
  const outbound: Array<string | undefined> = [];
  const client = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMessage: async (p: Record<string, any>) => {
      sent.push(p);
      outbound.push(currentOutboundTrace()?.traceparent);
      return { result: { kind: 'message', messageId: 'r', role: 'agent', parts: [] } };
    },
  } as unknown as A2AClient;
  return { client, sent, outbound };
}

const dispatchArgs = { agentUrl: 'https://b.example', skillId: 's', args: {}, correlationId: 'c' };

describe('DefaultA2ADispatcher trace forwarding', () => {
  it('forwards the inbound context as message metadata and outbound context', async () => {
    const { client, sent, outbound } = capturingClient();
    const d = new DefaultA2ADispatcher({ clientFactory: () => client, propagation: { parentAgentId: 'orchestrator', propagatedMetadata: { tenant: 'acme', token: 's3cret' } } });
    await runWithInboundTrace({ traceparent: TP, tracestate: 'v=1' }, () => d.dispatch(dispatchArgs));
    expect(sent[0]!.message.metadata).toEqual({
      traceparent: TP,
      tracestate: 'v=1',
      parent_agent_id: 'orchestrator',
      propagated_metadata: { tenant: 'acme', token: '[redacted]' },
    });
    expect(outbound[0]).toBe(TP);
  });

  it('adds no metadata when there is nothing to forward (previous behaviour)', async () => {
    const { client, sent, outbound } = capturingClient();
    await new DefaultA2ADispatcher({ clientFactory: () => client }).dispatch(dispatchArgs);
    expect(sent[0]!.message).not.toHaveProperty('metadata');
    expect(outbound[0]).toBeUndefined();
  });

  it('forwardTraceContext: false keeps attribution but drops the trace', async () => {
    const { client, sent, outbound } = capturingClient();
    const d = new DefaultA2ADispatcher({ clientFactory: () => client, propagation: { forwardTraceContext: false, parentAgentId: 'orchestrator' } });
    await runWithInboundTrace({ traceparent: TP }, () => d.dispatch(dispatchArgs));
    expect(sent[0]!.message.metadata).toEqual({ parent_agent_id: 'orchestrator' });
    expect(outbound[0]).toBeUndefined();
  });

  it('does not leak one call context into the next', async () => {
    const { client, outbound } = capturingClient();
    const d = new DefaultA2ADispatcher({ clientFactory: () => client });
    await runWithInboundTrace({ traceparent: TP }, () => d.dispatch(dispatchArgs));
    await d.dispatch(dispatchArgs);
    expect(outbound).toEqual([TP, undefined]);
  });
});

// ---------------------------------------------------------------------------
// CLIENT span
// ---------------------------------------------------------------------------

function fakeOtel() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: Array<{ name: string; kind?: number; attributes?: Record<string, unknown>; parent: any }> = [];
  const status: Array<{ code: number; message?: string }> = [];
  let ended = 0;
  const api = {
    ROOT_CONTEXT: { root: true },
    context: { active: () => ({ active: true }) },
    trace: { setSpanContext: (_c: unknown, sc: Record<string, unknown>) => ({ remote: sc }) },
  };
  const tracer = {
    startSpan(name: string, options?: { kind?: number; attributes?: Record<string, unknown> }, parent?: unknown) {
      calls.push({ name, ...(options ?? {}), parent });
      return {
        setAttribute() {},
        end() {
          ended++;
        },
        spanContext: () => ({ traceId: TRACE, spanId: 'c'.repeat(16), traceFlags: 1 }),
        setStatus: (s: { code: number; message?: string }) => status.push(s),
      };
    },
  };
  return { api, tracer, calls, status, ended: () => ended };
}

describe('startClientSpan', () => {
  it('passes the caller context through when no tracer is registered', async () => {
    const span = await startClientSpan({ traceparent: TP }, {});
    expect(span.carrier).toEqual({ traceparent: TP });
    span.end();
  });

  it('returns no carrier without a caller context or tracer', async () => {
    expect((await startClientSpan(undefined, {})).carrier).toBeUndefined();
  });

  it('creates a CLIENT span parented on the caller and injects its own context', async () => {
    const f = fakeOtel();
    setOtelApi(f.api);
    setOtelTracer(f.tracer);
    const span = await startClientSpan({ traceparent: TP, tracestate: 'v=1' }, { 'a2a.agent.url': 'x' });
    expect(f.calls[0]).toMatchObject({ name: 'SendMessage', kind: 3, attributes: { 'a2a.agent.url': 'x' } });
    expect(f.calls[0]!.parent).toEqual({ remote: { traceId: TRACE, spanId: SPAN, traceFlags: 1, isRemote: true } });
    expect(span.carrier).toEqual({ traceparent: `00-${TRACE}-${'c'.repeat(16)}-01`, tracestate: 'v=1' });
    span.end(new Error('boom'));
    expect(f.status).toEqual([{ code: 2, message: 'boom' }]);
    expect(f.ended()).toBe(1);
  });

  it('starts a span in the active context when there is no caller context', async () => {
    const f = fakeOtel();
    setOtelApi(f.api);
    setOtelTracer(f.tracer);
    const span = await startClientSpan(undefined, {});
    expect(f.calls[0]!.parent).toEqual({ active: true });
    expect(span.carrier?.traceparent).toMatch(/^00-[0-9a-f]{32}-c{16}-01$/);
  });

  it('falls back to pass-through when the OpenTelemetry API is unavailable', async () => {
    const f = fakeOtel();
    setOtelApi(undefined);
    setOtelTracer(f.tracer);
    expect((await startClientSpan({ traceparent: TP }, {})).carrier).toEqual({ traceparent: TP });
    expect(f.calls).toHaveLength(0);
  });

  it('never throws when the tracer does', async () => {
    const f = fakeOtel();
    setOtelApi(f.api);
    setOtelTracer({ startSpan: () => { throw new Error('tracer down'); } });
    expect((await startClientSpan({ traceparent: TP }, {})).carrier).toEqual({ traceparent: TP });
  });

  it('the dispatcher injects the client span context', async () => {
    const f = fakeOtel();
    setOtelApi(f.api);
    setOtelTracer(f.tracer);
    const { client, sent, outbound } = capturingClient();
    const d = new DefaultA2ADispatcher({ clientFactory: () => client });
    await runWithInboundTrace({ traceparent: TP }, () => d.dispatch(dispatchArgs));
    const expected = `00-${TRACE}-${'c'.repeat(16)}-01`;
    expect(sent[0]!.message.metadata.traceparent).toBe(expected);
    expect(outbound[0]).toBe(expected);
    expect(f.ended()).toBe(1);
  });
});
