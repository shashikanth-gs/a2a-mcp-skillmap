/**
 * HTTP transport adapter. Wraps a `BridgeEngine` behind Express + the MCP
 * `StreamableHTTPServerTransport`. Applies the configured `InboundAuthProvider`
 * as middleware before any MCP handling.
 *
 * @module mcp/http-server
 */

import type { AddressInfo } from 'node:net';
import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BridgeEngine } from '../core/engine.js';
import type { InboundAuthProvider } from '../types/index.js';
import { registerBridgeTools } from './register-tools.js';

export interface HttpAdapterOptions {
  port: number;
  inboundAuth?: InboundAuthProvider;
  info?: { name: string; version: string };
}

export interface HttpAdapter {
  readonly server: McpServer;
  readonly actualPort: number;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class HttpPortUnavailableError extends Error {
  public readonly code = 'PORT_UNAVAILABLE';
  public readonly port: number;

  constructor(port: number, cause?: unknown) {
    super(`HTTP port ${port} is not available`);
    this.name = 'HttpPortUnavailableError';
    this.port = port;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

export function createHttpAdapter(
  engine: BridgeEngine,
  options: HttpAdapterOptions,
): HttpAdapter {
  const server = new McpServer(
    options.info ?? { name: 'a2a-mcp-skillmap', version: '0.1.0' },
  );
  registerBridgeTools(server, engine);

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  // Inbound auth middleware (runs before MCP handling).
  if (options.inboundAuth) {
    app.use(async (req: Request, res: Response, next) => {
      try {
        const ok = await options.inboundAuth!.authenticate({
          headers: req.headers as Record<
            string,
            string | string[] | undefined
          >,
        });
        if (!ok) {
          res.status(401).json({
            error: {
              code: 'AUTH_FAILED',
              message: 'Authentication required',
            },
          });
          return;
        }
        next();
      } catch {
        /* c8 ignore next 4 -- defensive: should not happen */
        res.status(500).json({
          error: { code: 'INTERNAL', message: 'Auth handler failed' },
        });
      }
    });
  }

  // Stateless mode: the SDK refuses to reuse a transport across requests
  // ("Create a new transport per request"), so each request gets its own
  // transport and MCP server. Tool callbacks read the caller's `traceparent`
  // from this request's headers (see register-tools).
  app.all('/mcp', async (req, res) => {
    const perRequest = new McpServer(
      options.info ?? { name: 'a2a-mcp-skillmap', version: '0.1.0' },
    );
    registerBridgeTools(perRequest, engine);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on('close', () => {
      void transport.close();
      void perRequest.close();
    });
    try {
      await perRequest.connect(transport);
      await transport.handleRequest(req, res, req.body as unknown);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
      void err;
    }
  });

  let listener: import('node:http').Server | undefined;
  let actualPort = options.port;

  return {
    server,
    get actualPort() {
      return actualPort;
    },
    async start() {
      await new Promise<void>((resolve, reject) => {
        listener = app.listen(options.port);
        listener.once('listening', () => {
          const addr = listener!.address() as AddressInfo | null;
          if (addr && typeof addr === 'object') actualPort = addr.port;
          resolve();
        });
        listener.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
            reject(new HttpPortUnavailableError(options.port, err));
          } else {
            reject(err);
          }
        });
      });
    },
    async stop() {
      if (listener) {
        await new Promise<void>((resolve) => listener!.close(() => resolve()));
      }
    },
  };
}
