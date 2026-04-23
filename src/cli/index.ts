#!/usr/bin/env node
/**
 * a2a-mcp-skillmap CLI entry point.
 *
 * Parses flags with `commander`, merges with env vars + optional config file,
 * validates via Zod, then runs the bridge over the selected transport.
 *
 * @module cli
 */

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

/* c8 ignore next 10 -- only executed when run as a binary */
if (import.meta.url === `file://${process.argv[1]}`) {
  runCli().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
