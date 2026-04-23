/**
 * Integration test for the HTTP transport adapter.
 *
 * Starts the adapter on an ephemeral port (port=0), verifies that it is
 * listening, and that the inbound auth middleware rejects unauthenticated
 * requests.
 */

import { describe, it, expect } from 'vitest';
import { createBridge } from '../../src/core/create-bridge.js';
import { createHttpAdapter } from '../../src/mcp/http-server.js';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';
import { BearerInboundAuth } from '../../src/auth/inbound/index.js';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
} from '../../src/core/invocation-runtime.js';
import type { BridgeConfig } from '../../src/config/schema.js';

const CONFIG: BridgeConfig = {
  agents: [{ url: 'https://agent-a.example.com', auth: { mode: 'none' } }],
  transport: 'http',
  http: { port: 0, inboundAuth: { mode: 'none' } },
  responseMode: 'structured',
  syncBudgetMs: 5000,
  taskRetentionMs: 3_600_000,
  retry: { maxAttempts: 1, initialDelayMs: 0 },
  logging: { level: 'error' },
};

const CARD = {
  name: 'agent-a',
  description: 'x',
  version: '1.0.0',
  url: 'https://agent-a.example.com',
  protocolVersion: '0.3.0',
  defaultInputModes: [],
  defaultOutputModes: [],
  skills: [{ id: 'echo', name: 'echo', description: 'echo', tags: [] }],
};

class Stub implements A2ADispatcher {
  async dispatch(): Promise<A2ADispatchResponse> {
    return { kind: 'final', artifacts: [] };
  }
}

describe('createHttpAdapter', () => {
  it('starts on an ephemeral port and rejects unauthenticated requests when inbound auth is configured', async () => {
    const bridge = createBridge(CONFIG, {
      dispatcher: new Stub(),
      agentResolver: new AgentResolver({ fetcher: async () => CARD }),
    });
    await bridge.start();

    const adapter = createHttpAdapter(bridge.engine, {
      port: 0,
      inboundAuth: new BearerInboundAuth({ token: 'secret' }),
    });
    await adapter.start();
    try {
      const port = adapter.actualPort;
      expect(port).toBeGreaterThan(0);

      // No auth header → 401.
      const resNoAuth = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(resNoAuth.status).toBe(401);

      // Correct auth header reaches the MCP layer (we don't need it to
      // succeed — just to pass the middleware, which is signalled by a
      // non-401 response).
      const resAuthed = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer secret',
        },
        body: '{}',
      });
      expect(resAuthed.status).not.toBe(401);
    } finally {
      await adapter.stop();
      await bridge.stop();
    }
  });

  it('starts without inbound auth configured', async () => {
    const bridge = createBridge(CONFIG, {
      dispatcher: new Stub(),
      agentResolver: new AgentResolver({ fetcher: async () => CARD }),
    });
    await bridge.start();
    const adapter = createHttpAdapter(bridge.engine, { port: 0 });
    await adapter.start();
    try {
      expect(adapter.actualPort).toBeGreaterThan(0);
    } finally {
      await adapter.stop();
      await bridge.stop();
    }
  });
});
