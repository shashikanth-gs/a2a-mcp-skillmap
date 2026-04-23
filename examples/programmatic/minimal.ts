/**
 * Minimal programmatic bridge — stdio transport, one agent, no auth.
 *
 * Run: `npx tsx examples/programmatic/minimal.ts`
 */

import {
  createBridge,
  DefaultA2ADispatcher,
  createStdioAdapter,
  type BridgeConfig,
} from '../../src/index.js';

const config: BridgeConfig = {
  agents: [
    { url: 'https://agent.example.com', auth: { mode: 'none' } },
  ],
  transport: 'stdio',
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

const stdio = createStdioAdapter(bridge.engine);
await stdio.start();

// Graceful shutdown on Ctrl-C.
process.on('SIGINT', async () => {
  await stdio.stop();
  await bridge.stop();
  process.exit(0);
});
