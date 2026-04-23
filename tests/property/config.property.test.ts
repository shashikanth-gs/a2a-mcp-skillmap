/**
 * Property-based tests for the BridgeConfig schema and loader.
 *
 * Feature: a2a-mcp-skillmap
 * - Property 12: Configuration Round-Trip   — validates Requirements 18.1, 18.2
 * - Property 16: Config Precedence          — validates Requirements 17.2
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BridgeConfigSchema,
  parseConfig,
  prettyPrintConfig,
} from '../../src/config/schema.js';
import type { BridgeConfig } from '../../src/config/schema.js';
import { loadConfig } from '../../src/config/loader.js';
import type { RawConfig } from '../../src/config/loader.js';

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const agentUrlArb = fc
  .tuple(
    fc.constantFrom('https', 'http'),
    fc.stringMatching(/^[a-z][a-z0-9-]{2,20}\.(com|net|io|example)$/),
    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
  )
  .map(([scheme, host, port]) =>
    port !== undefined ? `${scheme}://${host}:${port}` : `${scheme}://${host}`,
  );

const tokenArb = fc.string({ minLength: 1, maxLength: 64 });
const headerNameArb = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,40}$/);

const authArb = fc.oneof(
  fc.record({ mode: fc.constant('none' as const) }),
  fc.record({
    mode: fc.constant('bearer' as const),
    token: tokenArb,
  }),
  fc.record({
    mode: fc.constant('api_key' as const),
    token: tokenArb,
    headerName: headerNameArb,
  }),
);

const agentEntryArb = fc.record({
  url: agentUrlArb,
  auth: authArb,
});

const retryArb = fc.record({
  maxAttempts: fc.integer({ min: 1, max: 10 }),
  initialDelayMs: fc.integer({ min: 0, max: 10_000 }),
});

const loggingArb = fc.record({
  level: fc.constantFrom(
    'trace',
    'debug',
    'info',
    'warn',
    'error',
    'fatal',
  ) as fc.Arbitrary<'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'>,
});

const inboundAuthArb = fc.oneof(
  fc.record({ mode: fc.constant('none' as const) }),
  fc.record({ mode: fc.constant('bearer' as const), token: tokenArb }),
  fc.record({
    mode: fc.constant('api_key' as const),
    token: tokenArb,
    headerName: headerNameArb,
  }),
);

const httpArb = fc.record({
  port: fc.integer({ min: 1, max: 65535 }),
  inboundAuth: inboundAuthArb,
});

/** Fully-specified BridgeConfig (every field set, run through Zod for defaults). */
const bridgeConfigArb: fc.Arbitrary<BridgeConfig> = fc
  .record({
    agents: fc.array(agentEntryArb, { minLength: 1, maxLength: 5 }),
    transport: fc.constantFrom('stdio', 'http') as fc.Arbitrary<
      'stdio' | 'http'
    >,
    http: httpArb,
    responseMode: fc.constantFrom(
      'structured',
      'compact',
      'artifact',
      'raw',
    ) as fc.Arbitrary<'structured' | 'compact' | 'artifact' | 'raw'>,
    syncBudgetMs: fc.integer({ min: 0, max: 600_000 }),
    taskRetentionMs: fc.integer({ min: 0, max: 86_400_000 }),
    retry: retryArb,
    logging: loggingArb,
  })
  .map((raw) => BridgeConfigSchema.parse(raw));

// ---------------------------------------------------------------------------
// Property 12: Configuration Round-Trip
// ---------------------------------------------------------------------------

describe('Property 12: Configuration Round-Trip', () => {
  it('parseConfig ∘ prettyPrintConfig is identity for any valid BridgeConfig', () => {
    fc.assert(
      fc.property(bridgeConfigArb, (config) => {
        const serialized = prettyPrintConfig(config);
        const roundTripped = parseConfig(serialized);
        expect(roundTripped).toEqual(config);
      }),
      { numRuns: 100 },
    );
  });

  it('round-trip is stable across multiple iterations', () => {
    fc.assert(
      fc.property(bridgeConfigArb, (config) => {
        const once = parseConfig(prettyPrintConfig(config));
        const twice = parseConfig(prettyPrintConfig(once));
        expect(twice).toEqual(once);
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 16: Config Precedence — CLI > env > file
// ---------------------------------------------------------------------------

/** Emit three distinct elements by shuffling a fixed pool. */
function threeDistinct<T>(pool: readonly T[]): fc.Arbitrary<[T, T, T]> {
  return fc
    .shuffledSubarray(pool as T[], { minLength: 3, maxLength: 3 })
    .map((arr) => [arr[0]!, arr[1]!, arr[2]!] as [T, T, T]);
}

/** Shared tmp directory for file-based test fixtures. */
let tmpDir: string;
beforeAll(() => {
  tmpDir = join(tmpdir(), `config-precedence-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

let fileCounter = 0;
function writeFileConfig(data: unknown): string {
  const path = join(tmpDir, `cfg-${fileCounter++}.json`);
  writeFileSync(path, JSON.stringify(data));
  return path;
}

describe('Property 16: Config Precedence', () => {
  it('CLI > env > file for responseMode when all three supply distinct values', () => {
    fc.assert(
      fc.property(
        threeDistinct(['structured', 'compact', 'raw'] as const),
        (modes) => {
          const fileMode = modes[0];
          const envMode = modes[1];
          const cliMode = modes[2];

          const filePath = writeFileConfig({
            agents: [{ url: 'https://file.example.com' }],
            responseMode: fileMode,
          });
          const env = { A2A_MCP_RESPONSE_MODE: envMode };
          const cli: Partial<RawConfig> = { responseMode: cliMode };

          // All three present → CLI wins.
          const all = loadConfig({ filePath, env, cli });
          expect(all.responseMode).toBe(cliMode);

          // CLI absent → env wins.
          const envOverFile = loadConfig({ filePath, env });
          expect(envOverFile.responseMode).toBe(envMode);

          // CLI and env absent → file wins.
          const fileOnly = loadConfig({ filePath });
          expect(fileOnly.responseMode).toBe(fileMode);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('CLI > env > file for transport when all three supply distinct-enough values', () => {
    // Only two valid transport values exist, so we pair transport with
    // syncBudgetMs to generate three unique scalar combinations.
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 100_001, max: 200_000 }),
        fc.integer({ min: 200_001, max: 300_000 }),
        (fileBudget, envBudget, cliBudget) => {
          const filePath = writeFileConfig({
            agents: [{ url: 'https://file.example.com' }],
            syncBudgetMs: fileBudget,
          });
          const env = { A2A_MCP_SYNC_BUDGET_MS: String(envBudget) };
          const cli: Partial<RawConfig> = { syncBudgetMs: cliBudget };

          expect(loadConfig({ filePath, env, cli }).syncBudgetMs).toBe(
            cliBudget,
          );
          expect(loadConfig({ filePath, env }).syncBudgetMs).toBe(envBudget);
          expect(loadConfig({ filePath }).syncBudgetMs).toBe(fileBudget);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('CLI > env > file for logging.level when all three supply distinct values', () => {
    fc.assert(
      fc.property(
        threeDistinct([
          'trace',
          'debug',
          'info',
          'warn',
          'error',
          'fatal',
        ] as const),
        (levels) => {
          const fileLevel = levels[0];
          const envLevel = levels[1];
          const cliLevel = levels[2];

          const filePath = writeFileConfig({
            agents: [{ url: 'https://file.example.com' }],
            logging: { level: fileLevel },
          });
          const env = { A2A_MCP_LOG_LEVEL: envLevel };
          const cli: Partial<RawConfig> = { logging: { level: cliLevel } };

          expect(loadConfig({ filePath, env, cli }).logging.level).toBe(
            cliLevel,
          );
          expect(loadConfig({ filePath, env }).logging.level).toBe(envLevel);
          expect(loadConfig({ filePath }).logging.level).toBe(fileLevel);
        },
      ),
      { numRuns: 100 },
    );
  });
});
