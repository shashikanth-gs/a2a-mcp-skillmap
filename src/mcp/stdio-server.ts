/**
 * Stdio transport adapter. Wraps a `BridgeEngine` with an `McpServer` and
 * connects it to `StdioServerTransport` so the bridge can be consumed by
 * any MCP client launched over stdio.
 *
 * @module mcp/stdio-server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { BridgeEngine } from '../core/engine.js';
import { registerBridgeTools } from './register-tools.js';

export interface StdioAdapterInfo {
  name: string;
  version: string;
}

export interface StdioAdapterOptions {
  info?: StdioAdapterInfo;
}

export interface StdioAdapter {
  readonly server: McpServer;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createStdioAdapter(
  engine: BridgeEngine,
  options: StdioAdapterOptions = {},
): StdioAdapter {
  const server = new McpServer(
    options.info ?? { name: 'a2a-mcp-skillmap', version: '0.1.0' },
  );
  registerBridgeTools(server, engine);
  const transport = new StdioServerTransport();

  return {
    server,
    async start() {
      await server.connect(transport);
    },
    async stop() {
      await server.close();
    },
  };
}
