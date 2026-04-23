/**
 * Replace the default ResponseProjector with a custom implementation.
 *
 * Use case: your MCP client prefers a specific envelope shape — e.g., it
 * wants every response wrapped in `{ ok, data }`. Implement the
 * `ResponseProjector` interface and pass it to `createBridge()`.
 *
 * Run: `npx tsx examples/programmatic/custom-projector.ts`
 */

import {
  createBridge,
  DefaultA2ADispatcher,
  createStdioAdapter,
  type BridgeConfig,
  type CanonicalResult,
  type ProjectionContext,
  type ResponseProjector,
} from '../../src/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

class WrappedProjector implements ResponseProjector {
  project(result: CanonicalResult, ctx: ProjectionContext): CallToolResult {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ok: result.status === 'success',
            tool: ctx.toolName,
            correlationId: ctx.correlationId,
            data: result.artifacts,
            taskId: result.taskId,
          }),
        },
      ],
      structuredContent: {
        ok: result.status === 'success',
        data: result.artifacts,
      },
    };
  }
}

const config: BridgeConfig = {
  agents: [{ url: 'https://agent.example.com', auth: { mode: 'none' } }],
  transport: 'stdio',
  responseMode: 'structured',
  syncBudgetMs: 30000,
  taskRetentionMs: 3_600_000,
  retry: { maxAttempts: 3, initialDelayMs: 500 },
  logging: { level: 'info' },
};

const bridge = createBridge(config, {
  dispatcher: new DefaultA2ADispatcher(),
  projector: new WrappedProjector(),
});

await bridge.start();
const stdio = createStdioAdapter(bridge.engine);
await stdio.start();

process.on('SIGINT', async () => {
  await stdio.stop();
  await bridge.stop();
  process.exit(0);
});
