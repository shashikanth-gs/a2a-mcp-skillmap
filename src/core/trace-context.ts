/**
 * W3C Trace Context handling for delegated calls.
 *
 * When a backend CLI (Copilot, Claude Code, ...) calls a bridge tool, it may
 * attach the trace context of the request it is serving, either as
 * `params._meta.traceparent` (MCP, stdio and HTTP) or as an HTTP `traceparent`
 * header (streamable HTTP only). This module extracts that context, validates it
 * strictly, and carries it to the dispatcher so the outgoing A2A request joins
 * the same trace.
 *
 * Measured backend behaviour: wrapper design doc `docs/design/distributed-tracing.md`,
 * section 8.6 / Appendix B (shashikanth-gs/a2a-wrapper#63).
 *
 * @module core/trace-context
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/** A validated W3C trace context. */
export interface TraceCarrier {
  /** `00-<trace-id>-<span-id>-<flags>` */
  traceparent: string;
  /** Validated `tracestate`, when present. */
  tracestate?: string;
}

export interface ParsedTraceparent {
  version: string;
  traceId: string;
  spanId: string;
  /** Raw flags byte. Bit 0 is the sampled flag. */
  traceFlags: number;
}

const TRACEPARENT_V00 = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const TRACESTATE_MEMBER = /^[a-z][a-z0-9_\-*/]{0,255}(?:@[a-z][a-z0-9_\-*/]{0,13})?=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}$/;

/**
 * Strictly parse a `traceparent` value (W3C Trace Context, section 3.2).
 *
 * Rejects: wrong length, upper case, version `ff`, all-zero trace or span id,
 * and extra fields on version `00`. A higher version with extra trailing fields
 * is accepted (forward compatible) and only the first four fields are used.
 */
export function parseTraceparent(value: unknown): ParsedTraceparent | undefined {
  if (typeof value !== 'string' || value.length < 55 || value.length > 512) return undefined;
  const head = value.slice(0, 55);
  const m = TRACEPARENT_V00.exec(head);
  if (!m) return undefined;
  const [, version, traceId, spanId, flags] = m as unknown as [string, string, string, string, string];
  if (version === 'ff') return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  if (value.length > 55) {
    // Version 00 must be exactly 55 chars; later versions may append "-...".
    if (version === '00' || value[55] !== '-') return undefined;
  }
  return { version, traceId, spanId, traceFlags: parseInt(flags, 16) };
}

/** Validate a `tracestate` (at most 32 members, 512 chars, each member well formed). */
export function sanitizeTracestate(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 512) return undefined;
  const members = trimmed.split(',').map((m) => m.trim()).filter(Boolean);
  if (members.length === 0 || members.length > 32) return undefined;
  return members.every((m) => TRACESTATE_MEMBER.test(m)) ? members.join(',') : undefined;
}

function firstString(v: unknown): string | undefined {
  // A repeated HTTP header arrives as an array: ambiguous, so reject it.
  return typeof v === 'string' ? v : undefined;
}

function carrierFrom(traceparent: unknown, tracestate: unknown): TraceCarrier | undefined {
  const tp = firstString(traceparent);
  if (!tp || !parseTraceparent(tp)) return undefined;
  const ts = sanitizeTracestate(firstString(tracestate));
  return { traceparent: tp, ...(ts ? { tracestate: ts } : {}) };
}

/**
 * Extract the caller's trace context from a tool call.
 *
 * Order: `params._meta` first (Copilot, any transport), then the HTTP header
 * (Claude Code, streamable HTTP). An invalid value in one carrier falls through
 * to the next; nothing valid yields `undefined`.
 */
export function extractTraceContext(input: {
  meta?: Record<string, unknown> | undefined;
  headers?: Record<string, string | string[] | undefined> | undefined;
}): TraceCarrier | undefined {
  const fromMeta = carrierFrom(input.meta?.['traceparent'], input.meta?.['tracestate']);
  if (fromMeta) return fromMeta;
  return carrierFrom(input.headers?.['traceparent'], input.headers?.['tracestate']);
}

// ---------------------------------------------------------------------------
// Async context
// ---------------------------------------------------------------------------

const inboundStore = new AsyncLocalStorage<TraceCarrier | undefined>();
const outboundStore = new AsyncLocalStorage<TraceCarrier | undefined>();

/** Run `fn` with the caller's trace context available to the dispatcher. */
export function runWithInboundTrace<T>(carrier: TraceCarrier | undefined, fn: () => T): T {
  return inboundStore.run(carrier, fn);
}

/** The trace context of the tool call being served, if any. */
export function currentInboundTrace(): TraceCarrier | undefined {
  return inboundStore.getStore();
}

/** Run `fn` with the context to inject into outgoing A2A HTTP requests. */
export function runWithOutboundTrace<T>(carrier: TraceCarrier | undefined, fn: () => T): T {
  return outboundStore.run(carrier, fn);
}

/** The context to inject into the A2A request currently being sent, if any. */
export function currentOutboundTrace(): TraceCarrier | undefined {
  return outboundStore.getStore();
}

// ---------------------------------------------------------------------------
// Propagated attribution
// ---------------------------------------------------------------------------

const MAX_KEYS = 64;
const MAX_BYTES = 8 * 1024;
const KEY_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const SECRET_KEY = /(pass(word|key|phrase)?|secret|token|authorization|api[-_.]?key|cookie|credential|private[-_.]?key)/i;

/**
 * Bound and scrub caller-supplied `propagated_metadata`: at most 64 keys and
 * 8 KB, key charset `[A-Za-z0-9_.-]`, values of secret-looking keys replaced
 * by `"[redacted]"`. Returns `undefined` when nothing remains.
 */
export function sanitizePropagatedMetadata(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: Record<string, unknown> = {};
  let bytes = 2;
  let count = 0;
  for (const [key, raw] of Object.entries(input as Record<string, unknown>)) {
    if (count >= MAX_KEYS) break;
    if (!KEY_PATTERN.test(key)) continue;
    const value = SECRET_KEY.test(key) ? '[redacted]' : raw;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      continue;
    }
    if (serialized === undefined) continue;
    const cost = Buffer.byteLength(key) + Buffer.byteLength(serialized) + 4;
    if (bytes + cost > MAX_BYTES) continue;
    out[key] = value;
    bytes += cost;
    count++;
  }
  return count > 0 ? out : undefined;
}
