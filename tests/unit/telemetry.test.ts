import { describe, it, expect } from 'vitest';
import {
  Telemetry,
  setOtelTracer,
  getOtelTracer,
  withSpan,
  type OtelTracerLike,
  type TelemetryEvent,
} from '../../src/core/telemetry.js';

describe('Telemetry', () => {
  it('fan-outs events to every subscriber', () => {
    const tel = new Telemetry();
    const a: TelemetryEvent[] = [];
    const b: TelemetryEvent[] = [];
    tel.subscribe((e) => a.push(e));
    tel.subscribe((e) => b.push(e));
    tel.emit({
      kind: 'invocation.start',
      correlationId: 'c',
      toolName: 't',
      agentUrl: 'https://x',
      skillId: 's',
      timestamp: 0,
    });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });

  it('unsubscribe removes the listener', () => {
    const tel = new Telemetry();
    const seen: TelemetryEvent[] = [];
    const unsub = tel.subscribe((e) => seen.push(e));
    unsub();
    tel.emit({
      kind: 'invocation.end',
      correlationId: 'c',
      toolName: 't',
      outcome: 'success',
      durationMs: 1,
      timestamp: 0,
    });
    expect(seen).toHaveLength(0);
  });
});

describe('OTEL tracer registry', () => {
  it('withSpan is a no-op when no tracer is registered', async () => {
    setOtelTracer(undefined);
    const result = await withSpan('x', {}, async () => 42);
    expect(result).toBe(42);
    expect(getOtelTracer()).toBeUndefined();
  });

  it('withSpan calls startSpan + end when a tracer is registered', async () => {
    const ended: string[] = [];
    const tracer: OtelTracerLike = {
      startSpan: (name) => ({
        setAttribute() {},
        end() {
          ended.push(name);
        },
      }),
    };
    setOtelTracer(tracer);
    const result = await withSpan('op', { a: 1 }, async () => 'ok');
    expect(result).toBe('ok');
    expect(ended).toEqual(['op']);
    setOtelTracer(undefined);
  });

  it('withSpan closes the span even when the block throws', async () => {
    const ended: string[] = [];
    const tracer: OtelTracerLike = {
      startSpan: (name) => ({
        setAttribute() {},
        end() {
          ended.push(name);
        },
      }),
    };
    setOtelTracer(tracer);
    await expect(
      withSpan('op', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(ended).toEqual(['op']);
    setOtelTracer(undefined);
  });
});
