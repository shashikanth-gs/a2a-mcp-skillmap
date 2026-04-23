/**
 * Feature: a2a-mcp-skillmap, Property 17: Correlation ID Consistency
 * Validates: Requirements 12.3
 *
 * All log entries and telemetry events emitted during a single invocation
 * carry the same `correlationId`.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { Writable } from 'node:stream';
import { createLogger, withCorrelation } from '../../src/core/logger.js';
import {
  Telemetry,
  type TelemetryEvent,
} from '../../src/core/telemetry.js';

function capturingStream(): { stream: Writable; lines: string[] } {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _enc, cb) {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      for (const line of text.split('\n').filter(Boolean)) lines.push(line);
      cb();
    },
  });
  return { stream, lines };
}

describe('Property 17: Correlation ID Consistency', () => {
  it('child logger stamps every entry with the same correlationId', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9-]{8,36}$/),
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), {
          minLength: 1,
          maxLength: 10,
        }),
        (correlationId, messages) => {
          const { stream, lines } = capturingStream();
          const root = createLogger({ level: 'trace', destination: stream });
          const child = withCorrelation(root, correlationId);

          for (const m of messages) child.info(m);

          expect(lines.length).toBe(messages.length);
          for (const line of lines) {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            expect(parsed['correlationId']).toBe(correlationId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('Telemetry events carrying the same correlationId stay consistent', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9-]{8,36}$/),
        fc.integer({ min: 1, max: 10 }),
        (correlationId, eventCount) => {
          const telemetry = new Telemetry();
          const seen: TelemetryEvent[] = [];
          telemetry.subscribe((e) => seen.push(e));

          telemetry.emit({
            kind: 'invocation.start',
            correlationId,
            toolName: 't',
            agentUrl: 'https://a.com',
            skillId: 's',
            timestamp: 0,
          });
          for (let i = 0; i < eventCount - 1; i++) {
            telemetry.emit({
              kind: 'task.transition',
              correlationId,
              taskId: `task-${i}`,
              from: 'running',
              to: 'completed',
              timestamp: i,
            });
          }

          expect(seen.length).toBe(eventCount);
          for (const e of seen) {
            expect(e.correlationId).toBe(correlationId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
