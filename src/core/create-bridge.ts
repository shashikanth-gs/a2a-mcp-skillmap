/**
 * `createBridge` — SDK factory that constructs a fully-wired `BridgeEngine`
 * from a validated `BridgeConfig`.
 *
 * Callers can inject custom subsystems (projector, naming strategy, dispatcher,
 * storage backends, auth providers) via the `options` argument without forking
 * the package.
 *
 * @module core/create-bridge
 */

import type {
  AgentAuthProvider,
  RegistryStore,
  ResponseProjector,
  TaskStore,
  ToolNamingStrategy,
} from '../types/index.js';
import type { BridgeConfig } from '../config/schema.js';
import { AgentRegistry } from './registry.js';
import { ToolGenerator } from './tool-generator.js';
import { TaskManager, type A2ACanceller } from './task-manager.js';
import { BridgeEngine } from './engine.js';
import type { A2ADispatcher } from './invocation-runtime.js';
import { AgentResolver } from '../a2a/agent-resolver.js';
import { MemoryRegistryStore } from '../storage/memory-registry-store.js';
import { MemoryTaskStore } from '../storage/memory-task-store.js';
import { createAgentAuth } from '../auth/outbound/index.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface BridgeInstance {
  readonly engine: BridgeEngine;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface CreateBridgeOptions {
  dispatcher: A2ADispatcher;
  canceller?: A2ACanceller;
  projector?: ResponseProjector;
  namingStrategy?: ToolNamingStrategy;
  registryStore?: RegistryStore;
  taskStore?: TaskStore;
  agentResolver?: AgentResolver;
  /** Override per-agent auth providers. When omitted, built from config. */
  authProviders?: Map<string, AgentAuthProvider>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBridge(
  config: BridgeConfig,
  options: CreateBridgeOptions,
): BridgeInstance {
  // Build auth providers from agent configs unless overridden.
  const authProviders =
    options.authProviders ??
    new Map(
      config.agents.map((a) => [
        a.url,
        createAgentAuth(
          {
            mode: a.auth.mode,
            ...(a.auth.token !== undefined ? { token: a.auth.token } : {}),
            ...(a.auth.headerName !== undefined
              ? { headerName: a.auth.headerName }
              : {}),
          },
          a.url,
        ),
      ]),
    );

  const registryStore = options.registryStore ?? new MemoryRegistryStore();
  const taskStore = options.taskStore ?? new MemoryTaskStore();

  const registry = new AgentRegistry({
    ...(options.agentResolver !== undefined
      ? { resolver: options.agentResolver }
      : {}),
    store: registryStore,
    retry: {
      maxAttempts: config.retry.maxAttempts,
      initialDelayMs: config.retry.initialDelayMs,
    },
    authProviders,
  });

  const toolGenerator = new ToolGenerator(
    options.namingStrategy ? { namingStrategy: options.namingStrategy } : {},
  );

  const taskManager = new TaskManager({
    store: taskStore,
    retentionMs: config.taskRetentionMs,
    ...(options.canceller !== undefined ? { canceller: options.canceller } : {}),
  });

  const engine = new BridgeEngine({
    registry,
    toolGenerator,
    dispatcher: options.dispatcher,
    taskManager,
    ...(options.projector !== undefined ? { projector: options.projector } : {}),
    responseMode: config.responseMode,
    syncBudgetMs: config.syncBudgetMs,
    agentConfigs: config.agents,
    authProviders,
    fallbackTool: config.fallbackTool,
  });

  return {
    engine,
    async start() {
      await engine.initialize();
    },
    async stop() {
      await engine.shutdown();
    },
  };
}
