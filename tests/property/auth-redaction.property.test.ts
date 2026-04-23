/**
 * Feature: a2a-mcp-skillmap, Property 11: Credential Redaction
 * Validates: Requirements 4.7, 7.5, 8.6, 12.5, 17.5
 *
 * For any configured credential value, the bridge MUST NOT emit that value in:
 *   - config summaries produced for logging (redactConfig)
 *   - outbound auth provider descriptions
 *   - inbound auth provider descriptions
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { redactConfig } from '../../src/config/loader.js';
import type { BridgeConfig } from '../../src/config/schema.js';
import {
  BearerAgentAuth,
  ApiKeyAgentAuth,
  NoopAgentAuth,
} from '../../src/auth/outbound/index.js';
import {
  BearerInboundAuth,
  ApiKeyInboundAuth,
} from '../../src/auth/inbound/index.js';

// Credentials must be distinguishable from the fixed redaction text. We
// restrict to digits + special chars so `token` cannot be a substring of
// "bearer", "api_key", "[REDACTED]", "Authorization", or a header name.
const nonEmptyCredArb = fc.stringMatching(/^[0-9!@#$%^&*+=~|;,.<>?-]{4,64}$/);

describe('Property 11: Credential Redaction', () => {
  it('redactConfig replaces agent + inbound tokens with [REDACTED]', () => {
    fc.assert(
      fc.property(nonEmptyCredArb, nonEmptyCredArb, (agentTok, inboundTok) => {
        const config: BridgeConfig = {
          agents: [
            {
              url: 'https://a.com',
              auth: { mode: 'bearer', token: agentTok },
            },
          ],
          transport: 'http',
          http: {
            port: 3000,
            inboundAuth: { mode: 'bearer', token: inboundTok },
          },
          responseMode: 'structured',
          syncBudgetMs: 30000,
          taskRetentionMs: 3600000,
          retry: { maxAttempts: 3, initialDelayMs: 500 },
          logging: { level: 'info' },
        };
        const red = redactConfig(config);
        const asJson = JSON.stringify(red);
        expect(asJson).not.toContain(agentTok);
        expect(asJson).not.toContain(inboundTok);
        expect(asJson).toContain('[REDACTED]');
      }),
      { numRuns: 100 },
    );
  });

  it('outbound BearerAgentAuth.redactedDescription never leaks token', () => {
    fc.assert(
      fc.property(nonEmptyCredArb, (token) => {
        const auth = new BearerAgentAuth(token);
        const desc = auth.redactedDescription();
        expect(desc).not.toContain(token);
        expect(desc).toContain('[REDACTED]');
      }),
      { numRuns: 100 },
    );
  });

  it('outbound ApiKeyAgentAuth.redactedDescription never leaks token', () => {
    fc.assert(
      fc.property(
        nonEmptyCredArb,
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,20}$/),
        (token, header) => {
          const auth = new ApiKeyAgentAuth(token, header);
          const desc = auth.redactedDescription();
          expect(desc).not.toContain(token);
          expect(desc).toContain('[REDACTED]');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('outbound applyAuth attaches the token to headers (but desc hides it)', () => {
    fc.assert(
      fc.property(nonEmptyCredArb, (token) => {
        const auth = new BearerAgentAuth(token);
        const headers: Record<string, string> = {};
        auth.applyAuth(headers);
        expect(headers['Authorization']).toBe(`Bearer ${token}`);
        expect(auth.redactedDescription()).not.toContain(token);
      }),
      { numRuns: 100 },
    );
  });

  it('inbound describe() methods redact token', () => {
    // Constrain to distinctive cred characters that cannot appear in the
    // fixed description strings (`bearer`, `api_key`, `[REDACTED]`, header name).
    const distinctCredArb = fc.stringMatching(
      /^[0-9!@#$%^&*+=~|;,.<>?-]{4,48}$/,
    );
    fc.assert(
      fc.property(distinctCredArb, (token) => {
        const bearer = new BearerInboundAuth({ token });
        const apiKey = new ApiKeyInboundAuth({ token });
        expect(bearer.describe()).not.toContain(token);
        expect(apiKey.describe()).not.toContain(token);
      }),
      { numRuns: 100 },
    );
  });

  it('NoopAgentAuth description contains no credential', () => {
    const auth = new NoopAgentAuth();
    expect(auth.redactedDescription()).toBe('none');
  });
});
