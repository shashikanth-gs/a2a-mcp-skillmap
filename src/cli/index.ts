#!/usr/bin/env node
/**
 * a2a-mcp-skillmap CLI entry point.
 *
 * Parses flags with `commander`, merges with env vars + optional config file,
 * validates via Zod, then runs the bridge over the selected transport.
 *
 * @module cli
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';
import { loadConfig, ConfigLoadError } from '../config/loader.js';
import type { RawConfig } from '../config/loader.js';
import { createBridge } from '../core/create-bridge.js';
import { DefaultA2ADispatcher } from '../a2a/dispatcher.js';
import { createStdioAdapter } from '../mcp/stdio-server.js';
import {
  createHttpAdapter,
  HttpPortUnavailableError,
} from '../mcp/http-server.js';
import { createInboundAuth } from '../auth/inbound/index.js';
import type { CreateBridgeOptions } from '../core/create-bridge.js';

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

export function buildProgram(): Command {
  const program = new Command('a2a-mcp-skillmap')
    .description('Bridge A2A agent skills into MCP tools')
    .option(
      '--a2a-url <url>',
      'A2A agent base URL (repeatable)',
      (value: string, prior: string[] = []) => [...prior, value],
      [] as string[],
    )
    .addOption(
      new Option('--transport <mode>', 'MCP transport to expose').choices([
        'stdio',
        'http',
      ]),
    )
    .option('--port <n>', 'HTTP port (when --transport=http)', (v) => Number(v))
    .addOption(
      new Option('--response-mode <mode>', 'Response shaping mode').choices([
        'structured',
        'compact',
        'artifact',
        'raw',
      ]),
    )
    .addOption(
      new Option(
        '--fallback-tool <mode>',
        'Fallback tool when an agent has zero skills',
      ).choices(['none', 'message']),
    )
    .option('--config <path>', 'Path to JSON configuration file')
    .option(
      '--log-level <level>',
      'Logging level (trace|debug|info|warn|error|fatal)',
    );
  return program;
}

// ---------------------------------------------------------------------------
// Flag translation
// ---------------------------------------------------------------------------

interface ParsedFlags {
  a2aUrl?: string[];
  transport?: string;
  port?: number;
  responseMode?: string;
  fallbackTool?: string;
  config?: string;
  logLevel?: string;
}

function flagsToRawConfig(flags: ParsedFlags): Partial<RawConfig> {
  const out: Partial<RawConfig> = {};
  if (flags.a2aUrl && flags.a2aUrl.length > 0) {
    out.agents = flags.a2aUrl.map((url) => ({ url }));
  }
  if (flags.transport !== undefined) out.transport = flags.transport;
  if (flags.port !== undefined) out.http = { port: flags.port };
  if (flags.responseMode !== undefined) out.responseMode = flags.responseMode;
  if (flags.fallbackTool !== undefined) out.fallbackTool = flags.fallbackTool;
  if (flags.logLevel !== undefined) out.logging = { level: flags.logLevel };
  return out;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/** Options injected by tests to override production defaults. */
export interface RunCliOverrides {
  bridgeOptions?: Partial<CreateBridgeOptions>;
  /** Force the actual bound HTTP port (e.g., 0 for ephemeral). */
  httpPortOverride?: number;
  /** Skip `.start()` on the stdio adapter (avoids taking over STDIN in tests). */
  skipStdioStart?: boolean;
}

/** Run the CLI. Exposed as a function so tests can drive it without exit. */
export async function runCli(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
  overrides: RunCliOverrides = {},
): Promise<{ stop: () => Promise<void> }> {
  const program = buildProgram();
  program.parse(argv);
  const flags = program.opts<ParsedFlags>();

  const config = (() => {
    try {
      return loadConfig({
        cli: flagsToRawConfig(flags),
        env,
        ...(flags.config !== undefined ? { filePath: flags.config } : {}),
      });
    } catch (err) {
      if (err instanceof ConfigLoadError) {
        process.stderr.write(`Configuration error: ${err.message}\n`);
        process.exit(2);
      }
      throw err;
    }
  })();

  const dispatcher =
    overrides.bridgeOptions?.dispatcher ?? new DefaultA2ADispatcher();
  const bridge = createBridge(config, {
    ...(overrides.bridgeOptions ?? {}),
    dispatcher,
  });
  await bridge.start();

  if (config.transport === 'http') {
    const port = overrides.httpPortOverride ?? config.http?.port ?? 3000;
    const inbound = config.http?.inboundAuth
      ? createInboundAuth({
          mode: config.http.inboundAuth.mode,
          ...(config.http.inboundAuth.token !== undefined
            ? { token: config.http.inboundAuth.token }
            : {}),
          ...(config.http.inboundAuth.headerName !== undefined
            ? { headerName: config.http.inboundAuth.headerName }
            : {}),
        })
      : undefined;

    const http = createHttpAdapter(bridge.engine, {
      port,
      ...(inbound !== undefined ? { inboundAuth: inbound } : {}),
    });
    try {
      await http.start();
    } catch (err) {
      if (err instanceof HttpPortUnavailableError) {
        process.stderr.write(
          `HTTP port ${err.port} is unavailable (${(err as Error).message})\n`,
        );
        process.exit(3);
      }
      throw err;
    }
    return {
      stop: async () => {
        await http.stop();
        await bridge.stop();
      },
    };
  }

  // Default to stdio.
  const stdio = createStdioAdapter(bridge.engine);
  if (!overrides.skipStdioStart) {
    await stdio.start();
  }
  return {
    stop: async () => {
      await stdio.stop();
      await bridge.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Direct execution
// ---------------------------------------------------------------------------

/**
 * Detect whether this module is the program entry point.
 *
 * A naive comparison of `import.meta.url` against `file://${process.argv[1]}`
 * fails whenever the two paths refer to the same file via different
 * representations:
 *   - macOS `/tmp` -> `/private/tmp` symlink (and any other symlinked path)
 *   - pnpm / nvm / Docker bind-mount layouts that traverse symlinks
 *   - Windows drive-letter casing, backslash vs. forward-slash separators,
 *     and URL-encoded characters in the file URL
 *
 * We canonicalize both sides through `fileURLToPath` (handles platform
 * separators and percent-encoding) and `realpathSync` (resolves symlinks)
 * before comparing. `realpathSync` is wrapped so that an unstattable
 * `argv[1]` is treated as "not the main module" rather than crashing.
 */
/* c8 ignore start -- only executed when run as a binary */
function isMainModule(): boolean {
  if (!import.meta.url.startsWith('file:')) return false;
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(invoked);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  runCli().catch((err) => {
    process.stderr.write(
      `Fatal: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
/* c8 ignore stop */
