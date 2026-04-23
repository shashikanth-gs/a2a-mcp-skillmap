/**
 * Shared helpers for wiring a `BridgeEngine` into an `McpServer`.
 * Used by both stdio and HTTP transport adapters.
 *
 * @module mcp/register-tools
 */

import { z, ZodObject } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BridgeEngine } from '../core/engine.js';

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
      async (args: unknown) => {
        const record =
          typeof args === 'object' && args !== null
            ? (args as Record<string, unknown>)
            : {};
        return engine.callTool(decl.name, record);
      },
    );
  }
}
