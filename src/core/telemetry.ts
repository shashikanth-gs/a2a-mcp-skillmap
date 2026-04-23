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
  startSpan(name: string, options?: { attributes?: Record<string, unknown> }): {
    setAttribute(key: string, value: unknown): void;
    end(): void;
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
