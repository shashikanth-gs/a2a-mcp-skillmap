/**
 * InvocationRuntime — translate validated MCP tool calls into A2A requests.
 *
 * Responsibilities:
 *   1. Validate invocation args against the skill's declared input schema.
 *      Reject BEFORE any outbound A2A call so a validation failure never
 *      leaks to the remote agent (Property 6).
 *   2. Dispatch to the A2A agent via a pluggable `A2ADispatcher`.
 *   3. Distinguish fast-path (immediate result) from long-path (task handle)
 *      based on the dispatcher's response shape.
 *   4. Normalize the outcome into a `CanonicalResult`, attaching correlation
 *      metadata and timing.
 *
 * @module core/invocation-runtime
 */

import type { ZodType } from 'zod';
import type {
  AgentAuthProvider,
  BridgeError,
  CanonicalError,
  CanonicalResult,
  FieldError,
  InvocationContext,
  ResolvedSkill,
  ToolSource,
} from '../types/index.js';
import { TaskManager } from './task-manager.js';
import { isFallbackSkill } from './fallback-skill.js';

// ---------------------------------------------------------------------------
// Dispatcher contract
// ---------------------------------------------------------------------------

/** Response shape returned by an A2A dispatcher. */
export type A2ADispatchResponse =
  | {
      kind: 'final';
      artifacts: Array<{ type: string; data: unknown; name?: string }>;
      a2aTaskId?: string;
    }
  | {
      kind: 'task-handle';
      a2aTaskId: string;
    }
  | {
      kind: 'error';
      code: string;
      message: string;
      details?: Record<string, unknown>;
    };

/** Pluggable transport that sends a validated invocation to an A2A agent. */
export interface A2ADispatcher {
  dispatch(params: {
    agentUrl: string;
    skillId: string;
    args: Record<string, unknown>;
    auth?: AgentAuthProvider;
    correlationId: string;
    /**
     * When true, the args include a `message: string` field and the
     * dispatcher should send a plain-text A2A message rather than a
     * `{ skillId, args }` data part. Set by the invocation runtime when the
     * caller's skill is the bridge's synthesized fallback skill.
     */
    fallback?: boolean;
  }): Promise<A2ADispatchResponse>;
}

// ---------------------------------------------------------------------------
// Skill lookup
// ---------------------------------------------------------------------------

/** Resolver that maps a ToolSource to its canonical ResolvedSkill + schema. */
export interface SkillLookup {
  find(source: ToolSource): {
    skill: ResolvedSkill;
    inputSchema: ZodType;
  } | undefined;
  authFor(agentUrl: string): AgentAuthProvider | undefined;
}

// ---------------------------------------------------------------------------
// Outcome shape
// ---------------------------------------------------------------------------

export type InvocationOutcome =
  | {
      kind: 'fast-path';
      result: CanonicalResult;
    }
  | {
      kind: 'long-path';
      result: CanonicalResult;
      bridgeTaskId: string;
    }
  | {
      kind: 'error';
      error: BridgeError;
    };

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface InvocationRuntimeOptions {
  dispatcher: A2ADispatcher;
  lookup: SkillLookup;
  taskManager: TaskManager;
  clock?: { now(): number };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class InvocationRuntime {
  private readonly dispatcher: A2ADispatcher;
  private readonly lookup: SkillLookup;
  private readonly taskManager: TaskManager;
  private readonly clock: { now(): number };

  constructor(options: InvocationRuntimeOptions) {
    this.dispatcher = options.dispatcher;
    this.lookup = options.lookup;
    this.taskManager = options.taskManager;
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  async invoke(
    source: ToolSource,
    args: Record<string, unknown>,
    context: InvocationContext,
  ): Promise<InvocationOutcome> {
    const entry = this.lookup.find(source);
    if (!entry) {
      return {
        kind: 'error',
        error: {
          code: 'TOOL_NOT_FOUND',
          message: `Unknown tool source: ${source.agentId}/${source.skillId}`,
          correlationId: context.correlationId,
        },
      };
    }

    // 1. Input validation GATE — must reject before any outbound call.
    const parsed = entry.inputSchema.safeParse(args);
    if (!parsed.success) {
      const fields: FieldError[] = parsed.error.issues.map((i) => ({
        path: i.path.join('.') || '$',
        message: i.message,
      }));
      return {
        kind: 'error',
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Tool input validation failed',
          correlationId: context.correlationId,
          details: { fields },
        },
      };
    }

    // 2. Dispatch to A2A agent.
    const start = this.clock.now();
    const auth = this.lookup.authFor(source.agentUrl);
    let response: A2ADispatchResponse;
    try {
      response = await this.dispatcher.dispatch({
        agentUrl: source.agentUrl,
        skillId: source.skillId,
        args: parsed.data as Record<string, unknown>,
        auth,
        correlationId: context.correlationId,
        fallback: isFallbackSkill(entry.skill),
      });
    } catch (err) {
      return {
        kind: 'error',
        error: {
          code: 'A2A_PROTOCOL_ERROR',
          message: err instanceof Error ? err.message : String(err),
          correlationId: context.correlationId,
          details: { agentUrl: source.agentUrl },
        },
      };
    }

    const durationMs = this.clock.now() - start;

    // 3. Route based on response kind.
    if (response.kind === 'error') {
      const canonical: CanonicalError = {
        code: response.code,
        message: response.message,
        correlationId: context.correlationId,
        details: response.details,
      };
      return {
        kind: 'error',
        error: {
          code: canonical.code,
          message: canonical.message,
          correlationId: canonical.correlationId,
          details: { agentUrl: source.agentUrl },
        },
      };
    }

    if (response.kind === 'final') {
      const result: CanonicalResult = {
        status: 'success',
        artifacts: response.artifacts,
        metadata: {
          agentUrl: source.agentUrl,
          skillId: source.skillId,
          durationMs,
          correlationId: context.correlationId,
          ...(response.a2aTaskId !== undefined
            ? { a2aTaskId: response.a2aTaskId }
            : {}),
        },
      };
      return { kind: 'fast-path', result };
    }

    // Long path: create a tracked bridge task.
    const task = this.taskManager.createTask(
      response.a2aTaskId,
      source.agentUrl,
      source.skillId,
    );
    const result: CanonicalResult = {
      status: 'success',
      taskId: task.taskId,
      taskState: task.state,
      artifacts: [],
      metadata: {
        agentUrl: source.agentUrl,
        skillId: source.skillId,
        durationMs,
        correlationId: context.correlationId,
        a2aTaskId: response.a2aTaskId,
      },
    };
    return { kind: 'long-path', result, bridgeTaskId: task.taskId };
  }
}
