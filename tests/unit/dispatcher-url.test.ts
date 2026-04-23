/**
 * Unit tests for `resolveCardUrl` — the well-known probing helper used by
 * both `AgentResolver` and `DefaultA2ADispatcher`.
 *
 * Behavior covered:
 *   - Explicit card URLs (.json/.yaml/.yml) are fetched as-is.
 *   - Base URLs probe `.well-known/agent-card.json` first, `.well-known/agent.json` second.
 *   - First 2xx wins.
 *   - When both probes fail, a `CardUrlResolutionError` is thrown that lists
 *     every attempt (for operator debugging).
 */

import { describe, it, expect } from 'vitest';
import {
  resolveCardUrl,
  CardUrlResolutionError,
} from '../../src/a2a/card-url.js';

function stubFetch(
  responses: Record<string, { status: number; body?: string }>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input.toString();
    const r = responses[url];
    if (!r) throw new Error(`unexpected fetch: ${url}`);
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body ?? '',
    } as Response;
  }) as typeof fetch;
}

describe('resolveCardUrl', () => {
  it('uses an explicit card URL as-is', async () => {
    const url = 'http://localhost:4003/.well-known/agent-card.json';
    const out = await resolveCardUrl(
      url,
      stubFetch({ [url]: { status: 200, body: '{"ok":true}' } }),
    );
    expect(out.cardUrl).toBe(url);
    expect(out.cardText).toBe('{"ok":true}');
  });

  it('probes agent-card.json first for base URLs and succeeds on 200', async () => {
    const base = 'http://localhost:4003';
    const primary = `${base}/.well-known/agent-card.json`;
    const out = await resolveCardUrl(
      base,
      stubFetch({ [primary]: { status: 200, body: '{"x":1}' } }),
    );
    expect(out.cardUrl).toBe(primary);
  });

  it('falls back to agent.json when agent-card.json returns 404', async () => {
    const base = 'http://localhost:4003';
    const primary = `${base}/.well-known/agent-card.json`;
    const secondary = `${base}/.well-known/agent.json`;
    const out = await resolveCardUrl(
      base,
      stubFetch({
        [primary]: { status: 404 },
        [secondary]: { status: 200, body: '{"legacy":true}' },
      }),
    );
    expect(out.cardUrl).toBe(secondary);
    expect(out.cardText).toBe('{"legacy":true}');
  });

  it('handles trailing slashes in the base URL', async () => {
    const base = 'http://localhost:4003/';
    const primary = 'http://localhost:4003/.well-known/agent-card.json';
    const out = await resolveCardUrl(
      base,
      stubFetch({ [primary]: { status: 200, body: '{}' } }),
    );
    expect(out.cardUrl).toBe(primary);
  });

  it('preserves a non-root base path', async () => {
    const base = 'https://agent.example.com/api/v1';
    const primary = 'https://agent.example.com/api/v1/.well-known/agent-card.json';
    const out = await resolveCardUrl(
      base,
      stubFetch({ [primary]: { status: 200, body: '{}' } }),
    );
    expect(out.cardUrl).toBe(primary);
  });

  it('leaves yaml card URLs alone', async () => {
    const url = 'https://a.com/card.yaml';
    const out = await resolveCardUrl(
      url,
      stubFetch({ [url]: { status: 200, body: 'key: value' } }),
    );
    expect(out.cardUrl).toBe(url);
  });

  it('throws CardUrlResolutionError with every attempt when both probes fail', async () => {
    const base = 'http://localhost:4003';
    const primary = `${base}/.well-known/agent-card.json`;
    const secondary = `${base}/.well-known/agent.json`;
    try {
      await resolveCardUrl(
        base,
        stubFetch({
          [primary]: { status: 404 },
          [secondary]: { status: 410 },
        }),
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CardUrlResolutionError);
      const cue = err as CardUrlResolutionError;
      expect(cue.attempts.map((a) => a.url)).toEqual([primary, secondary]);
      expect(cue.attempts.map((a) => a.status)).toEqual([404, 410]);
    }
  });

  it('records fetch throws as error attempts', async () => {
    const base = 'http://localhost:4003';
    const thrower: typeof fetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    try {
      await resolveCardUrl(base, thrower);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CardUrlResolutionError);
      const cue = err as CardUrlResolutionError;
      expect(cue.attempts).toHaveLength(2);
      expect(cue.attempts[0]!.error).toBe('ECONNREFUSED');
    }
  });
});
