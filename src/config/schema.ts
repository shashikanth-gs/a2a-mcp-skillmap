/**
 * Bridge configuration schema and utilities.
 *
 * Defines the Zod schema for BridgeConfig, the inferred TypeScript type,
 * and parser / pretty-printer / validator functions that support round-trip
 * correctness (Property 12).
 *
 * @module config/schema
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema Definition
// ---------------------------------------------------------------------------

/**
 * Zod schema for the bridge configuration file.
 *
 * Validated at startup; every field carries a sensible default so that a
 * minimal config (just `agents`) is sufficient.
 */
export const BridgeConfigSchema = z.object({
  agents: z
    .array(
      z.object({
        url: z.string().url(),
        auth: z
          .object({
            mode: z.enum(['none', 'bearer', 'api_key']),
            token: z.string().optional(),
            headerName: z.string().optional(),
          })
          .default({ mode: 'none' }),
      }),
    )
    .min(1),

  transport: z.enum(['stdio', 'http']).default('stdio'),

  http: z
    .object({
      port: z.number().int().min(1).max(65535).default(3000),
      inboundAuth: z
        .object({
          mode: z.enum(['none', 'bearer', 'api_key']).default('none'),
          token: z.string().optional(),
          headerName: z.string().optional(),
        })
        .default({ mode: 'none' }),
    })
    .optional(),

  responseMode: z
    .enum(['structured', 'compact', 'artifact', 'raw'])
    .default('artifact'),

  fallbackTool: z.enum(['none', 'message']).default('message'),

  syncBudgetMs: z.number().int().min(0).default(30_000),

  taskRetentionMs: z.number().int().min(0).default(3_600_000), // 1 hour

  retry: z
    .object({
      maxAttempts: z.number().int().min(1).default(3),
      initialDelayMs: z.number().int().min(0).default(500),
    })
    .default({}),

  logging: z
    .object({
      level: z
        .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
        .default('info'),
    })
    .default({}),
});

// ---------------------------------------------------------------------------
// Inferred Type
// ---------------------------------------------------------------------------

/** Fully-resolved bridge configuration after Zod parsing and defaults. */
export type BridgeConfig = z.infer<typeof BridgeConfigSchema>;

// ---------------------------------------------------------------------------
// Parser / Validator / Pretty-Printer
// ---------------------------------------------------------------------------

/**
 * Parse a JSON string into a validated {@link BridgeConfig}.
 *
 * Applies Zod defaults so the returned object is always fully populated.
 *
 * @param input - A JSON-encoded string representing the configuration.
 * @returns A validated and default-filled `BridgeConfig`.
 * @throws {z.ZodError} When the input fails schema validation.
 * @throws {SyntaxError} When the input is not valid JSON.
 */
export function parseConfig(input: string): BridgeConfig {
  const raw: unknown = JSON.parse(input);
  return BridgeConfigSchema.parse(raw);
}

/**
 * Validate an unknown value against the {@link BridgeConfigSchema}.
 *
 * Useful when the caller already has a parsed object (e.g. from merging
 * CLI flags, env vars, and a config file) and needs schema validation
 * without an intermediate JSON serialization step.
 *
 * @param input - An unknown value to validate.
 * @returns A validated and default-filled `BridgeConfig`.
 * @throws {z.ZodError} When the input fails schema validation.
 */
export function validateConfig(input: unknown): BridgeConfig {
  return BridgeConfigSchema.parse(input);
}

/**
 * Serialize a {@link BridgeConfig} to a formatted JSON string.
 *
 * The output is deterministic (keys in insertion order, 2-space indent)
 * and suitable for writing to a configuration file.
 *
 * Round-trip guarantee (Property 12):
 *   `parseConfig(prettyPrintConfig(config))` produces a semantically
 *   equivalent `BridgeConfig` for any valid input.
 *
 * @param config - A validated `BridgeConfig` object.
 * @returns A pretty-printed JSON string.
 */
export function prettyPrintConfig(config: BridgeConfig): string {
  return JSON.stringify(config, null, 2);
}
