/**
 * Telemetry hooks and metrics surface.
 *
 * Consumers receive structured events without having to parse logs. An
 * optional OpenTelemetry span emission can be wired via
 * {@link setOtelTracer}, which is a no-op unless a tracer is provided
 * (keeps `@opentelemetry/api` as an optional peer dependency).
 *
 * @module core/telemetry
 */

import { parseTraceparent, type TraceCarrier } from './trace-context.js';

// ---------------------------------------------------------------------------
// Event shapes
// ---------------------------------------------------------------------------

export type TelemetryEvent =
  | {
      kind: 'invocation.start';
      correlationId: string;
      toolName: string;
      agentUrl: string;
      skillId: string;
      timestamp: number;
    }
  | {
      kind: 'invocation.end';
      correlationId: string;
      toolName: string;
      outcome: 'success' | 'error' | 'long-path';
      durationMs: number;
      timestamp: number;
    }
  | {
      kind: 'agent.resolve';
      correlationId: string;
      agentUrl: string;
      outcome: 'success' | 'failure';
      attempts: number;
      durationMs: number;
      timestamp: number;
    }
  | {
      kind: 'task.transition';
      correlationId: string;
      taskId: string;
      from: string;
      to: string;
      timestamp: number;
    };

export type TelemetryListener = (event: TelemetryEvent) => void;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Telemetry emitter. Callers register listeners via `subscribe`; each emit
 * call fans out synchronously to every listener. Listeners must not throw —
 * the emitter does not catch exceptions (tests should enforce this).
 */
export class Telemetry {
  private listeners: TelemetryListener[] = [];

  subscribe(listener: TelemetryListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  emit(event: TelemetryEvent): void {
    for (const l of this.listeners) l(event);
  }
}

// ---------------------------------------------------------------------------
// Optional OpenTelemetry bridge
// ---------------------------------------------------------------------------

/**
 * Opaque tracer interface — a structural subset of the OpenTelemetry API.
 * Callers pass in a concrete `@opentelemetry/api` tracer; the bridge never
 * imports the package directly.
 */
export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: { attributes?: Record<string, unknown>; kind?: number },
    /** An OpenTelemetry `Context` (opaque here), used as the span's parent. */
    context?: unknown,
  ): {
    setAttribute(key: string, value: unknown): void;
    end(): void;
    /** Present on real OpenTelemetry spans; needed to forward the span's context. */
    spanContext?(): { traceId: string; spanId: string; traceFlags: number };
    setStatus?(status: { code: number; message?: string }): void;
  };
}

let _tracer: OtelTracerLike | undefined;

export function setOtelTracer(tracer: OtelTracerLike | undefined): void {
  _tracer = tracer;
}

export function getOtelTracer(): OtelTracerLike | undefined {
  return _tracer;
}

/**
 * Helper that wraps an async block with an OpenTelemetry span when a tracer
 * is registered. Returns the block's result; the span is always closed.
 */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, unknown>,
  block: () => Promise<T>,
): Promise<T> {
  const tracer = _tracer;
  if (!tracer) return block();
  const span = tracer.startSpan(name, { attributes });
  try {
    return await block();
  } finally {
    span.end();
  }
}

// ---------------------------------------------------------------------------
// Client span for delegated A2A calls
// ---------------------------------------------------------------------------

/** OpenTelemetry `SpanKind.CLIENT`. */
const SPAN_KIND_CLIENT = 3;

interface OtelApiLike {
  ROOT_CONTEXT: unknown;
  context: { active(): unknown };
  trace: { setSpanContext(ctx: unknown, sc: Record<string, unknown>): unknown };
}

let _api: Promise<OtelApiLike | undefined> | undefined;

/**
 * Supply the `@opentelemetry/api` module explicitly (or `undefined` to forget
 * it). Needed where the optional peer cannot be resolved by a dynamic import,
 * for example in a bundled deployment, and handy in tests.
 */
export function setOtelApi(api: unknown): void {
  _api = Promise.resolve(api as OtelApiLike | undefined);
}

/** Load the optional `@opentelemetry/api` peer once; `undefined` when absent. */
function loadOtelApi(): Promise<OtelApiLike | undefined> {
  _api ??= (async () => {
    try {
      const specifier = '@opentelemetry/api';
      return (await import(specifier)) as OtelApiLike;
    } catch {
      return undefined;
    }
  })();
  return _api;
}

export interface ClientSpan {
  /** Context to inject into the outgoing A2A request (the span's, else the caller's). */
  carrier: TraceCarrier | undefined;
  /** End the span; pass an error to mark it failed. */
  end(error?: unknown): void;
}

/**
 * Start the CLIENT span for one delegated A2A call and compute the context to
 * inject.
 *
 * - Tracer registered and `@opentelemetry/api` available: create a CLIENT span
 *   parented on the caller's context (or the active context when there is none)
 *   and inject **its** context, so the sub-agent becomes a child of this hop.
 * - Otherwise: pass the caller's context through unchanged, so the sub-agent
 *   joins the caller's trace directly.
 * - No caller context and no tracer: nothing is injected (previous behaviour).
 */
export async function startClientSpan(
  inbound: TraceCarrier | undefined,
  attributes: Record<string, unknown>,
): Promise<ClientSpan> {
  const passthrough: ClientSpan = { carrier: inbound, end() {} };
  const tracer = _tracer;
  if (!tracer) return passthrough;
  try {
    const api = await loadOtelApi();
    if (!api) return passthrough;

    let parent: unknown = api.context.active();
    const parsed = inbound ? parseTraceparent(inbound.traceparent) : undefined;
    if (parsed) {
      parent = api.trace.setSpanContext(api.ROOT_CONTEXT, {
        traceId: parsed.traceId,
        spanId: parsed.spanId,
        traceFlags: parsed.traceFlags & 1,
        isRemote: true,
      });
    }

    const span = tracer.startSpan('SendMessage', { kind: SPAN_KIND_CLIENT, attributes }, parent);
    const sc = span.spanContext?.();
    const flags = ((sc?.traceFlags ?? 0) & 1).toString(16).padStart(2, '0');
    const carrier: TraceCarrier | undefined =
      sc && /^[0-9a-f]{32}$/.test(sc.traceId) && /^[0-9a-f]{16}$/.test(sc.spanId)
        ? {
            traceparent: `00-${sc.traceId}-${sc.spanId}-${flags}`,
            ...(inbound?.tracestate ? { tracestate: inbound.tracestate } : {}),
          }
        : inbound;
    return {
      carrier,
      end(error?: unknown) {
        try {
          if (error !== undefined) {
            span.setStatus?.({ code: 2, message: error instanceof Error ? error.message : String(error) });
          }
          span.end();
        } catch {
          /* tracing must never affect delegation */
        }
      },
    };
  } catch {
    return passthrough;
  }
}
