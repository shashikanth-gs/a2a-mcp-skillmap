/**
 * Configuration loader with three-tier precedence merging.
 *
 * Loads configuration from CLI flags, environment variables, and a config file,
 * then merges them with precedence: CLI > env > file. The merged result is
 * validated against {@link BridgeConfigSchema}.
 *
 * @module config/loader
 */

import { readFileSync } from 'node:fs';
import { ZodError } from 'zod';
import { BridgeConfigSchema } from './schema.js';
import type { BridgeConfig } from './schema.js';

// ---------------------------------------------------------------------------
// Public Types
// ---------------------------------------------------------------------------

/**
 * Raw (unvalidated) configuration shape before Zod parsing.
 * Every field is optional — merging fills in what each source provides.
 */
export interface RawConfig {
  agents?: Array<{
    url: string;
    auth?: { mode?: string; token?: string; headerName?: string };
  }>;
  transport?: string;
  http?: {
    port?: number;
    inboundAuth?: { mode?: string; token?: string; headerName?: string };
  };
  responseMode?: string;
  fallbackTool?: string;
  syncBudgetMs?: number;
  taskRetentionMs?: number;
  retry?: { maxAttempts?: number; initialDelayMs?: number };
  logging?: { level?: string };
}

/** Sources from which configuration can be loaded. */
export interface ConfigSources {
  /** Values parsed from CLI flags (highest precedence). */
  cli?: Partial<RawConfig>;
  /** Environment variables (or a subset). */
  env?: Record<string, string | undefined>;
  /** Path to a JSON configuration file (lowest precedence). */
  filePath?: string;
}

// ---------------------------------------------------------------------------
// Structured Error
// ---------------------------------------------------------------------------

/** Error thrown when configuration loading or validation fails. */
export class ConfigLoadError extends Error {
  public readonly code: string;
  public readonly details: { fields?: Array<{ path: string; message: string }> };

  constructor(
    message: string,
    code: string,
    details: { fields?: Array<{ path: string; message: string }> } = {},
  ) {
    super(message);
    this.name = 'ConfigLoadError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// Environment Variable Mapping
// ---------------------------------------------------------------------------

/**
 * Build a partial {@link RawConfig} from environment variables.
 *
 * Only keys that are actually set (non-undefined, non-empty) are included
 * so that absent env vars do not override lower-precedence sources.
 */
function configFromEnv(
  env: Record<string, string | undefined>,
): Partial<RawConfig> {
  const raw: Partial<RawConfig> = {};

  // Agents — comma-separated URLs
  const agentsEnv = env['A2A_MCP_AGENTS'];
  if (agentsEnv) {
    raw.agents = agentsEnv
      .split(',')
      .map((u) => u.trim())
      .filter(Boolean)
      .map((url) => ({ url }));
  }

  if (env['A2A_MCP_TRANSPORT']) {
    raw.transport = env['A2A_MCP_TRANSPORT'];
  }

  if (env['A2A_MCP_RESPONSE_MODE']) {
    raw.responseMode = env['A2A_MCP_RESPONSE_MODE'];
  }

  if (env['A2A_MCP_FALLBACK_TOOL']) {
    raw.fallbackTool = env['A2A_MCP_FALLBACK_TOOL'];
  }

  if (env['A2A_MCP_SYNC_BUDGET_MS']) {
    const n = Number(env['A2A_MCP_SYNC_BUDGET_MS']);
    if (!Number.isNaN(n)) raw.syncBudgetMs = n;
  }

  if (env['A2A_MCP_TASK_RETENTION_MS']) {
    const n = Number(env['A2A_MCP_TASK_RETENTION_MS']);
    if (!Number.isNaN(n)) raw.taskRetentionMs = n;
  }

  if (env['A2A_MCP_LOG_LEVEL']) {
    raw.logging = { level: env['A2A_MCP_LOG_LEVEL'] };
  }

  // HTTP port
  if (env['A2A_MCP_PORT']) {
    const port = Number(env['A2A_MCP_PORT']);
    if (!Number.isNaN(port)) {
      raw.http = { ...raw.http, port };
    }
  }

  // Inbound auth
  const inboundMode = env['A2A_MCP_INBOUND_AUTH_MODE'];
  const inboundToken = env['A2A_MCP_INBOUND_AUTH_TOKEN'];
  const inboundHeader = env['A2A_MCP_INBOUND_AUTH_HEADER'];
  if (inboundMode || inboundToken || inboundHeader) {
    const inboundAuth: Record<string, string> = {};
    if (inboundMode) inboundAuth['mode'] = inboundMode;
    if (inboundToken) inboundAuth['token'] = inboundToken;
    if (inboundHeader) inboundAuth['headerName'] = inboundHeader;
    raw.http = {
      ...raw.http,
      inboundAuth: inboundAuth as RawConfig['http'] extends infer H
        ? H extends { inboundAuth?: infer IA }
          ? IA
          : never
        : never,
    };
  }

  // Retry
  const retryMax = env['A2A_MCP_RETRY_MAX_ATTEMPTS'];
  const retryDelay = env['A2A_MCP_RETRY_INITIAL_DELAY_MS'];
  if (retryMax || retryDelay) {
    const retry: Record<string, number> = {};
    if (retryMax) {
      const n = Number(retryMax);
      if (!Number.isNaN(n)) retry['maxAttempts'] = n;
    }
    if (retryDelay) {
      const n = Number(retryDelay);
      if (!Number.isNaN(n)) retry['initialDelayMs'] = n;
    }
    raw.retry = retry as RawConfig['retry'];
  }

  return raw;
}

// ---------------------------------------------------------------------------
// Config File Loading
// ---------------------------------------------------------------------------

function loadConfigFile(filePath: string): Partial<RawConfig> {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err: unknown) {
    const message =
      err instanceof Error ? err.message : 'Unknown file read error';
    throw new ConfigLoadError(
      `Failed to read config file: ${filePath} — ${message}`,
      'CONFIG_FILE_READ_ERROR',
    );
  }

  try {
    return JSON.parse(content) as Partial<RawConfig>;
  } catch {
    throw new ConfigLoadError(
      `Config file is not valid JSON: ${filePath}`,
      'CONFIG_FILE_PARSE_ERROR',
    );
  }
}

// ---------------------------------------------------------------------------
// Deep Merge (two levels)
// ---------------------------------------------------------------------------

/**
 * Shallow-merge two objects, preferring values from `high` over `low`.
 * Only keys that are defined (not `undefined`) in `high` override `low`.
 * Nested objects (http, retry, logging, inboundAuth) are merged one level deep.
 */
function mergeRaw(
  low: Partial<RawConfig>,
  high: Partial<RawConfig>,
): Partial<RawConfig> {
  const result: Partial<RawConfig> = { ...low };

  // Top-level scalars
  if (high.agents !== undefined) result.agents = high.agents;
  if (high.transport !== undefined) result.transport = high.transport;
  if (high.responseMode !== undefined) result.responseMode = high.responseMode;
  if (high.fallbackTool !== undefined) result.fallbackTool = high.fallbackTool;
  if (high.syncBudgetMs !== undefined) result.syncBudgetMs = high.syncBudgetMs;
  if (high.taskRetentionMs !== undefined)
    result.taskRetentionMs = high.taskRetentionMs;

  // Nested: retry
  if (high.retry !== undefined) {
    result.retry = { ...result.retry, ...high.retry };
  }

  // Nested: logging
  if (high.logging !== undefined) {
    result.logging = { ...result.logging, ...high.logging };
  }

  // Nested: http (with deeper inboundAuth)
  if (high.http !== undefined) {
    const mergedHttp = { ...result.http };
    if (high.http.port !== undefined) mergedHttp.port = high.http.port;
    if (high.http.inboundAuth !== undefined) {
      mergedHttp.inboundAuth = {
        ...mergedHttp.inboundAuth,
        ...high.http.inboundAuth,
      };
    }
    result.http = mergedHttp;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Credential Redaction
// ---------------------------------------------------------------------------

/**
 * Return a deep copy of a {@link BridgeConfig} with all credential values
 * replaced by `[REDACTED]`. Safe for logging.
 */
export function redactConfig(config: BridgeConfig): Record<string, unknown> {
  // Deep clone via structured clone (available in Node 17+)
  const clone = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;

  // Redact agent auth tokens
  const agents = clone['agents'] as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(agents)) {
    for (const agent of agents) {
      const auth = agent['auth'] as Record<string, unknown> | undefined;
      if (auth && auth['token'] !== undefined) {
        auth['token'] = '[REDACTED]';
      }
    }
  }

  // Redact inbound auth token
  const http = clone['http'] as Record<string, unknown> | undefined;
  if (http) {
    const inboundAuth = http['inboundAuth'] as
      | Record<string, unknown>
      | undefined;
    if (inboundAuth && inboundAuth['token'] !== undefined) {
      inboundAuth['token'] = '[REDACTED]';
    }
  }

  return clone;
}

// ---------------------------------------------------------------------------
// Main Loader
// ---------------------------------------------------------------------------

/**
 * Load, merge, and validate bridge configuration from multiple sources.
 *
 * Precedence (highest to lowest): CLI flags → environment variables → config file.
 *
 * @param sources - The configuration sources to merge.
 * @returns A fully validated and default-filled {@link BridgeConfig}.
 * @throws {ConfigLoadError} When the config file cannot be read/parsed or
 *   the merged configuration fails schema validation.
 */
export function loadConfig(sources: ConfigSources = {}): BridgeConfig {
  // 1. Load config file (lowest precedence)
  const fileConfig: Partial<RawConfig> = sources.filePath
    ? loadConfigFile(sources.filePath)
    : {};

  // 2. Load env vars (middle precedence)
  const envConfig: Partial<RawConfig> = sources.env
    ? configFromEnv(sources.env)
    : {};

  // 3. CLI flags (highest precedence)
  const cliConfig: Partial<RawConfig> = sources.cli ?? {};

  // 4. Merge: file < env < cli
  const merged = mergeRaw(mergeRaw(fileConfig, envConfig), cliConfig);

  // 5. Validate against schema
  try {
    return BridgeConfigSchema.parse(merged);
  } catch (err: unknown) {
    if (err instanceof ZodError) {
      const fields = err.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      }));
      throw new ConfigLoadError(
        `Configuration validation failed: ${fields.map((f) => `${f.path}: ${f.message}`).join('; ')}`,
        'CONFIG_VALIDATION_ERROR',
        { fields },
      );
    }
    throw err;
  }
}
