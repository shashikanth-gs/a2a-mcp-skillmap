/**
 * Integration test for the stdio transport adapter. We do not spin up actual
 * stdio pipes — instead we verify that `createStdioAdapter` builds an McpServer
 * and registers the expected tools.
 */

import { describe, it, expect } from 'vitest';
import { createBridge } from '../../src/core/create-bridge.js';
import { createStdioAdapter } from '../../src/mcp/stdio-server.js';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
} from '../../src/core/invocation-runtime.js';
import type { BridgeConfig } from '../../src/config/schema.js';

const CONFIG: BridgeConfig = {
  agents: [{ url: 'https://agent-a.example.com', auth: { mode: 'none' } }],
  transport: 'stdio',
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
  skills: [
    {
      id: 'echo',
      name: 'echo',
      description: 'echo',
      tags: [],
      inputSchema: { type: 'object', properties: { m: { type: 'string' } } },
    },
  ],
};

class Stub implements A2ADispatcher {
  async dispatch(): Promise<A2ADispatchResponse> {
    return { kind: 'final', artifacts: [{ type: 'text', data: 'ok' }] };
  }
}

describe('createStdioAdapter', () => {
  it('constructs an McpServer and registers bridge tools without throwing', async () => {
    const bridge = createBridge(CONFIG, {
      dispatcher: new Stub(),
      agentResolver: new AgentResolver({ fetcher: async () => CARD }),
    });
    await bridge.start();
    const adapter = createStdioAdapter(bridge.engine, {
      info: { name: 'test', version: '0.0.1' },
    });
    expect(adapter.server).toBeDefined();
    // We don't actually call `.start()` — doing so binds stdio. The important
    // invariant is that tool registration succeeded without throwing.
  });
});
