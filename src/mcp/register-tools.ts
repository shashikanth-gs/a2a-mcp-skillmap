/**
 * Shared helpers for wiring a `BridgeEngine` into an `McpServer`.
 * Used by both stdio and HTTP transport adapters.
 *
 * @module mcp/register-tools
 */

import { z, ZodObject } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeEngine } from '../core/engine.js';
import { extractTraceContext, runWithInboundTrace } from '../core/trace-context.js';

/** The parts of the MCP request handler context this module reads. */
interface ToolExtra {
  _meta?: unknown;
  requestInfo?: { headers?: Record<string, string | string[] | undefined> };
}

/**
 * Register every declared tool on the engine with the supplied `McpServer`.
 * `registerTool` expects a Zod object shape; when a tool's input schema is
 * not a ZodObject (e.g., a primitive), we wrap the value under an `args` key.
 */
export function registerBridgeTools(
  server: McpServer,
  engine: BridgeEngine,
): void {
  for (const decl of engine.listTools()) {
    const shape =
      decl.inputSchema instanceof ZodObject
        ? (decl.inputSchema.shape as Record<string, z.ZodType>)
        : { args: decl.inputSchema };

    server.registerTool(
      decl.name,
      {
        description: decl.description,
        inputSchema: shape,
      },
      async (args: unknown, extra?: ToolExtra) => {
        const record =
          typeof args === 'object' && args !== null
            ? (args as Record<string, unknown>)
            : {};
        // The caller's trace context: MCP `_meta.traceparent` (Copilot, any
        // transport) or the HTTP `traceparent` header (Claude Code, HTTP only).
        const trace = extractTraceContext({
          meta: extra?._meta as Record<string, unknown> | undefined,
          headers: extra?.requestInfo?.headers,
        });
        return runWithInboundTrace(trace, () => engine.callTool(decl.name, record));
      },
    );
  }
}
