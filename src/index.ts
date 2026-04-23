// SDK entry point — re-export all public types
export type {
  ResolvedAgent,
  ResolvedSkill,
  CanonicalResult,
  Artifact,
  ResultMetadata,
  CanonicalError,
  TaskState,
  BridgeTask,
  ToolDeclaration,
  ToolSource,
  ToolNamingStrategy,
  ResponseMode,
  InvocationContext,
  ProjectionContext,
  ResponseProjector,
  AgentConfig,
  FieldError,
  BridgeError,
  TaskFilter,
  RegistryStore,
  TaskStore,
  IncomingRequest,
  InboundAuthProvider,
  AgentAuthProvider,
} from './types/index.js';

export { VALID_TRANSITIONS } from './types/index.js';

// Configuration schema and utilities
export {
  BridgeConfigSchema,
  parseConfig,
  prettyPrintConfig,
  validateConfig,
} from './config/schema.js';
export type { BridgeConfig } from './config/schema.js';

// Configuration loader
export { loadConfig, redactConfig, ConfigLoadError } from './config/loader.js';
export type { ConfigSources, RawConfig } from './config/loader.js';

// A2A layer
export {
  normalizeSkill,
  normalizeSkills,
  buildInputSchema,
  jsonSchemaToZod,
  SkillNormalizationError,
} from './a2a/skill-normalizer.js';
export type {
  A2AInputSkill,
  A2AAgentMeta,
} from './a2a/skill-normalizer.js';

export {
  AgentResolver,
  AgentResolutionError,
  AgentCardShapeSchema,
} from './a2a/agent-resolver.js';
export type {
  AgentCardFetcher,
  AgentResolverOptions,
  AgentCardShape,
} from './a2a/agent-resolver.js';

// Core registry
export { AgentRegistry, AgentRegistryError } from './core/registry.js';
export type { AgentRegistryOptions, RetryConfig } from './core/registry.js';

// Storage backends
export { MemoryRegistryStore } from './storage/memory-registry-store.js';

// Tool naming + generation
export {
  DefaultToolNamingStrategy,
  MAX_MCP_TOOL_NAME_LENGTH,
} from './core/tool-naming.js';
export { ToolGenerator } from './core/tool-generator.js';
export type { ToolGeneratorOptions } from './core/tool-generator.js';

// Task management + storage
export { MemoryTaskStore } from './storage/memory-task-store.js';
export { TaskManager, TaskManagerError } from './core/task-manager.js';
export type {
  A2ACanceller,
  Clock,
  TaskManagerOptions,
  TaskUpdatePayload,
} from './core/task-manager.js';

// Response projection
export { DefaultResponseProjector } from './core/response-projector.js';

// Auth — inbound
export {
  NoopInboundAuth,
  BearerInboundAuth,
  ApiKeyInboundAuth,
  createInboundAuth,
  InboundAuthMisconfiguredError,
} from './auth/inbound/index.js';
export type {
  BearerInboundAuthConfig,
  ApiKeyInboundAuthConfig,
  InboundAuthConfig,
} from './auth/inbound/index.js';

// Auth — outbound
export {
  NoopAgentAuth,
  BearerAgentAuth,
  ApiKeyAgentAuth,
  createAgentAuth,
  OutboundAuthMisconfiguredError,
} from './auth/outbound/index.js';
export type { AgentAuthConfig } from './auth/outbound/index.js';

// Invocation runtime
export { InvocationRuntime } from './core/invocation-runtime.js';
export type {
  A2ADispatcher,
  A2ADispatchResponse,
  InvocationOutcome,
  InvocationRuntimeOptions,
  SkillLookup,
} from './core/invocation-runtime.js';

// Bridge engine + factory
export { BridgeEngine } from './core/engine.js';
export type { BridgeEngineOptions } from './core/engine.js';
export { createBridge } from './core/create-bridge.js';
export type { BridgeInstance, CreateBridgeOptions } from './core/create-bridge.js';

// Fallback-skill synthesizer
export {
  applyFallbackSkill,
  isFallbackSkill,
  FALLBACK_SKILL_ID,
  FALLBACK_SKILL_TAG,
} from './core/fallback-skill.js';
export type { FallbackMode } from './core/fallback-skill.js';

// Default A2A dispatcher
export { DefaultA2ADispatcher } from './a2a/dispatcher.js';
export { resolveCardUrl, CardUrlResolutionError } from './a2a/card-url.js';
export type { ResolvedCard } from './a2a/card-url.js';

// Observability
export {
  createLogger,
  withCorrelation,
} from './core/logger.js';
export type { LogLevel, LoggerOptions, Logger } from './core/logger.js';
export {
  Telemetry,
  setOtelTracer,
  getOtelTracer,
  withSpan,
} from './core/telemetry.js';
export type {
  TelemetryEvent,
  TelemetryListener,
  OtelTracerLike,
} from './core/telemetry.js';

// MCP transport adapters
export { createStdioAdapter } from './mcp/stdio-server.js';
export type { StdioAdapter, StdioAdapterOptions } from './mcp/stdio-server.js';
export {
  createHttpAdapter,
  HttpPortUnavailableError,
} from './mcp/http-server.js';
export type { HttpAdapter, HttpAdapterOptions } from './mcp/http-server.js';
