/**
 * HTTP transport with inbound bearer auth + per-agent outbound auth.
 *
 * Run: `npx tsx examples/programmatic/http-auth.ts`
 */

import {
  createBridge,
  DefaultA2ADispatcher,
  createHttpAdapter,
  createInboundAuth,
  type BridgeConfig,
} from '../../src/index.js';

const config: BridgeConfig = {
  agents: [
    {
      url: 'https://research-agent.example.com',
      auth: { mode: 'bearer', token: process.env['RESEARCH_TOKEN'] ?? '' },
    },
    {
      url: 'https://public-agent.example.com',
      auth: { mode: 'none' },
    },
  ],
  transport: 'http',
  http: {
    port: 3000,
    inboundAuth: {
      mode: 'bearer',
      token: process.env['INBOUND_TOKEN'] ?? 'dev-secret',
    },
  },
  responseMode: 'structured',
  syncBudgetMs: 30000,
  taskRetentionMs: 3_600_000,
  retry: { maxAttempts: 3, initialDelayMs: 500 },
  logging: { level: 'info' },
};

const bridge = createBridge(config, {
  dispatcher: new DefaultA2ADispatcher(),
});
await bridge.start();

const inbound = createInboundAuth(config.http!.inboundAuth);
const http = createHttpAdapter(bridge.engine, {
  port: config.http!.port,
  inboundAuth: inbound,
});
await http.start();

console.log(`Bridge listening on http://localhost:${http.actualPort}/mcp`);

process.on('SIGINT', async () => {
  await http.stop();
  await bridge.stop();
  process.exit(0);
});
