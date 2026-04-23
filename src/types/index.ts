/**
 * Canonical model types for a2a-mcp-skillmap.
 *
 * All external data (A2A agent cards, A2A responses, MCP requests) is validated
 * at ingress and normalized into these typed internal representations before the
 * core engine processes it.
 */

import type { ZodType } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

// ---------------------------------------------------------------------------
// Agent & Skill Models
// ---------------------------------------------------------------------------

/** Resolved representation of an A2A agent. */
export interface ResolvedAgent {
  /** The operator-supplied URL (may be a base URL or an explicit card URL). */
  url: string;
  /** The URL the card was actually fetched from (post well-known probing). */
  cardUrl: string;
  id: string;
  name: string;
  version: string;
  description?: string;
  skills: ResolvedSkill[];
  rawCard: unknown; // AgentCard from @a2a-js/sdk — use unknown to avoid tight coupling
}

/** Canonical skill representation. */
export interface ResolvedSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
  inputSchema?: Record<string, unknown>; // JSON Schema from A2A skill
  inputModes: string[];
  outputModes: string[];
  agentUrl: string;
  agentId: string;
}

// ---------------------------------------------------------------------------
// Invocation Result Models
// ---------------------------------------------------------------------------

/** Canonical invocation result. */
export interface CanonicalResult {
  status: 'success' | 'error';
  taskId?: string; // present only on long-path
  taskState?: TaskState; // present only on long-path
  artifacts: Artifact[];
  metadata: ResultMetadata;
}

/** A single artifact produced by an A2A invocation. */
export interface Artifact {
  type: string; // MIME type
  data: unknown; // payload
  name?: string;
}

/** Metadata attached to every canonical result. */
export interface ResultMetadata {
  agentUrl: string;
  skillId: string;
  durationMs: number;
  correlationId: string;
  a2aTaskId?: string;
}

/** Canonical error representation. */
export interface CanonicalError {
  code: string;
  message: string;
  correlationId: string;
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Task Lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle state of a long-running invocation. */
export type TaskState = 'running' | 'completed' | 'failed' | 'cancelled';

/** Valid state transitions for BridgeTask. */
export const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  running: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** A tracked long-running A2A task. */
export interface BridgeTask {
  taskId: string; // Bridge-assigned UUID (node:crypto randomUUID)
  a2aTaskId: string; // Remote A2A task ID
  agentUrl: string;
  skillId: string;
  state: TaskState;
  createdAt: number; // epoch ms
  updatedAt: number; // epoch ms
  result?: CanonicalResult;
  error?: CanonicalError;
}

// ---------------------------------------------------------------------------
// Tool Declaration & Naming
// ---------------------------------------------------------------------------

/** An MCP tool declaration derived from an A2A skill. */
export interface ToolDeclaration {
  name: string;
  description: string;
  inputSchema: ZodType;
  metadata: ToolSource;
}

/** Identifies the A2A source of a projected MCP tool. */
export interface ToolSource {
  agentUrl: string;
  agentId: string;
  skillId: string;
}

/** Strategy for deriving deterministic MCP tool names. */
export interface ToolNamingStrategy {
  /** Derive a deterministic MCP tool name from agent + skill identifiers. */
  deriveName(agentId: string, skillId: string): string;
  /** Check if a candidate name is valid per MCP constraints. */
  isValid(name: string): boolean;
}

// ---------------------------------------------------------------------------
// Invocation & Projection Contexts
// ---------------------------------------------------------------------------

/** Response shaping mode. */
export type ResponseMode = 'structured' | 'compact' | 'artifact' | 'raw';

/** Context passed to InvocationRuntime for a single tool call. */
export interface InvocationContext {
  correlationId: string;
  responseMode: ResponseMode;
  syncBudgetMs: number;
}

/** Context passed to ResponseProjector for result shaping. */
export interface ProjectionContext {
  mode: ResponseMode;
  toolName: string;
  correlationId: string;
}

// ---------------------------------------------------------------------------
// Response Projection
// ---------------------------------------------------------------------------

/** Transforms canonical results into MCP CallToolResult payloads. */
export interface ResponseProjector {
  /** Project a canonical result into an MCP CallToolResult. */
  project(result: CanonicalResult, context: ProjectionContext): CallToolResult;
}

// ---------------------------------------------------------------------------
// Agent Configuration
// ---------------------------------------------------------------------------

/** Per-agent configuration entry. */
export interface AgentConfig {
  url: string;
  auth: {
    mode: 'none' | 'bearer' | 'api_key';
    token?: string;
    headerName?: string;
  };
}

// ---------------------------------------------------------------------------
// Error Types
// ---------------------------------------------------------------------------

/** Validation error for a single field. */
export interface FieldError {
  path: string;
  message: string;
  expected?: string;
}

/** Structured bridge error returned in MCP error responses. */
export interface BridgeError {
  code: string;
  message: string;
  correlationId: string;
  details?: {
    fields?: FieldError[];
    agentUrl?: string;
    taskId?: string;
  };
}

// ---------------------------------------------------------------------------
// Task Filtering
// ---------------------------------------------------------------------------

/** Filter criteria for listing tasks. */
export interface TaskFilter {
  state?: TaskState;
  agentUrl?: string;
  skillId?: string;
}

// ---------------------------------------------------------------------------
// Storage Interfaces
// ---------------------------------------------------------------------------

/** Pluggable storage backend for resolved agents. */
export interface RegistryStore {
  /** Store a resolved agent. */
  put(agentUrl: string, agent: ResolvedAgent): void;
  /** Retrieve a resolved agent. */
  get(agentUrl: string): ResolvedAgent | undefined;
  /** List all resolved agents. */
  list(): ResolvedAgent[];
  /** Remove an agent. */
  delete(agentUrl: string): void;
}

/** Pluggable storage backend for bridge tasks. */
export interface TaskStore {
  /** Store a task. */
  put(task: BridgeTask): void;
  /** Retrieve a task by bridge task ID. */
  get(taskId: string): BridgeTask | undefined;
  /** Update a task. */
  update(task: BridgeTask): void;
  /** Delete a task. */
  delete(taskId: string): void;
  /** List tasks matching a filter. */
  list(filter?: TaskFilter): BridgeTask[];
}

// ---------------------------------------------------------------------------
// Auth Provider Interfaces
// ---------------------------------------------------------------------------

/** Incoming HTTP request shape for auth providers. */
export interface IncomingRequest {
  headers: Record<string, string | string[] | undefined>;
}

/** Inbound authentication provider for HTTP transport. */
export interface InboundAuthProvider {
  /** Validate an incoming HTTP request. Returns true if authorized. */
  authenticate(req: IncomingRequest): Promise<boolean>;
}

/** Outbound authentication provider for A2A agent requests. */
export interface AgentAuthProvider {
  /** Attach credentials to an outbound A2A request. */
  applyAuth(headers: Record<string, string>): void;
  /** Return a redacted description for logging. */
  redactedDescription(): string;
}
