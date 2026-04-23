/**
 * Wire up full observability: pino logger with correlation IDs, telemetry
 * listener for structured events, and (optional) OpenTelemetry tracer.
 *
 * Run: `npx tsx examples/programmatic/observability.ts`
 */

import {
  createBridge,
  DefaultA2ADispatcher,
  createStdioAdapter,
  createLogger,
  withCorrelation,
  Telemetry,
  setOtelTracer,
  type BridgeConfig,
} from '../../src/index.js';

// 1. Structured logger — credentials are redacted automatically.
const logger = createLogger({ level: 'debug' });
logger.info('bridge-start', 'starting a2a-mcp-skillmap');

// 2. Telemetry listener — consume events without parsing logs.
const telemetry = new Telemetry();
telemetry.subscribe((event) => {
  logger.info({ event }, 'telemetry');
});

// 3. Optional OpenTelemetry tracer — uncomment when @opentelemetry/api is installed.
// import { trace } from '@opentelemetry/api';
// setOtelTracer(trace.getTracer('a2a-mcp-skillmap'));

// Demonstration: child logger bound to a correlation ID.
const childLog = withCorrelation(logger, 'corr-demo-123');
childLog.info('every log line from this child carries correlationId=corr-demo-123');

const config: BridgeConfig = {
  agents: [{ url: 'https://agent.example.com', auth: { mode: 'none' } }],
  transport: 'stdio',
  responseMode: 'structured',
  syncBudgetMs: 30000,
  taskRetentionMs: 3_600_000,
  retry: { maxAttempts: 3, initialDelayMs: 500 },
  logging: { level: 'debug' },
};

const bridge = createBridge(config, {
  dispatcher: new DefaultA2ADispatcher(),
});

await bridge.start();
const stdio = createStdioAdapter(bridge.engine);
await stdio.start();

process.on('SIGINT', async () => {
  await stdio.stop();
  await bridge.stop();
  process.exit(0);
});

// Suppress the "setOtelTracer is unused" warning from the commented block above.
void setOtelTracer;
