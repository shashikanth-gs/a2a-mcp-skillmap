import { describe, it, expect } from 'vitest';
import {
  BridgeConfigSchema,
  parseConfig,
  prettyPrintConfig,
  validateConfig,
} from '../../src/config/schema.js';
import type { BridgeConfig } from '../../src/config/schema.js';

/** Minimal valid config — only the required `agents` field. */
const MINIMAL_INPUT = {
  agents: [{ url: 'https://agent.example.com' }],
};

/** Fully-specified config with every field set. */
const FULL_INPUT: BridgeConfig = {
  agents: [
    {
      url: 'https://agent.example.com',
      auth: { mode: 'bearer', token: 'secret' },
    },
  ],
  transport: 'http',
  http: {
    port: 8080,
    inboundAuth: { mode: 'api_key', token: 'key123', headerName: 'X-Api-Key' },
  },
  responseMode: 'compact',
  fallbackTool: 'message',
  syncBudgetMs: 5000,
  taskRetentionMs: 7200000,
  retry: { maxAttempts: 5, initialDelayMs: 1000 },
  logging: { level: 'debug' },
};

describe('BridgeConfigSchema', () => {
  it('parses a minimal config and fills defaults', () => {
    const result = BridgeConfigSchema.parse(MINIMAL_INPUT);

    expect(result.transport).toBe('stdio');
    expect(result.responseMode).toBe('artifact');
    expect(result.syncBudgetMs).toBe(30_000);
    expect(result.taskRetentionMs).toBe(3_600_000);
    expect(result.retry).toEqual({ maxAttempts: 3, initialDelayMs: 500 });
    expect(result.logging).toEqual({ level: 'info' });
    expect(result.agents[0].auth).toEqual({ mode: 'none' });
    expect(result.http).toBeUndefined();
  });

  it('parses a fully-specified config without altering values', () => {
    const result = BridgeConfigSchema.parse(FULL_INPUT);
    expect(result).toEqual(FULL_INPUT);
  });

  it('rejects an empty agents array', () => {
    expect(() => BridgeConfigSchema.parse({ agents: [] })).toThrow();
  });

  it('rejects a missing agents field', () => {
    expect(() => BridgeConfigSchema.parse({})).toThrow();
  });

  it('rejects an invalid agent URL', () => {
    expect(() =>
      BridgeConfigSchema.parse({ agents: [{ url: 'not-a-url' }] }),
    ).toThrow();
  });

  it('rejects an out-of-range port', () => {
    expect(() =>
      BridgeConfigSchema.parse({
        agents: [{ url: 'https://a.com' }],
        http: { port: 0 },
      }),
    ).toThrow();

    expect(() =>
      BridgeConfigSchema.parse({
        agents: [{ url: 'https://a.com' }],
        http: { port: 70000 },
      }),
    ).toThrow();
  });
});

describe('parseConfig', () => {
  it('parses a JSON string into a validated BridgeConfig', () => {
    const json = JSON.stringify(MINIMAL_INPUT);
    const result = parseConfig(json);
    expect(result.agents).toHaveLength(1);
    expect(result.transport).toBe('stdio');
  });

  it('throws SyntaxError on invalid JSON', () => {
    expect(() => parseConfig('{')).toThrow(SyntaxError);
  });

  it('throws ZodError on schema violation', () => {
    expect(() => parseConfig('{}')).toThrow();
  });
});

describe('validateConfig', () => {
  it('validates an unknown object against the schema', () => {
    const result = validateConfig(MINIMAL_INPUT);
    expect(result.agents).toHaveLength(1);
  });

  it('throws on invalid input', () => {
    expect(() => validateConfig({ agents: [] })).toThrow();
  });
});

describe('prettyPrintConfig', () => {
  it('serializes a BridgeConfig to formatted JSON', () => {
    const config = BridgeConfigSchema.parse(MINIMAL_INPUT);
    const json = prettyPrintConfig(config);
    expect(json).toContain('\n'); // formatted
    expect(JSON.parse(json)).toEqual(config);
  });
});

describe('round-trip: parseConfig ∘ prettyPrintConfig', () => {
  it('produces a semantically equivalent config for a minimal input', () => {
    const config = BridgeConfigSchema.parse(MINIMAL_INPUT);
    const roundTripped = parseConfig(prettyPrintConfig(config));
    expect(roundTripped).toEqual(config);
  });

  it('produces a semantically equivalent config for a full input', () => {
    const roundTripped = parseConfig(prettyPrintConfig(FULL_INPUT));
    expect(roundTripped).toEqual(FULL_INPUT);
  });
});
