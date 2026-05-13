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

import { randomUUID } from 'node:crypto';
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
import { createLogger } from './logger.js';

const log = createLogger({ level: 'debug' });

/**
 * Returns true when a skill should be invoked via a plain-text A2A part
 * rather than a structured data part. This applies when:
 *   - The skill declares no inputSchema (untyped), AND
 *   - The skill's inputModes are absent or exclusively `text/plain`.
 *
 * An absent inputModes list is treated as text-only: if the agent didn't
 * declare structured input modes, we assume it handles free-form text.
 */
function isTextOnlySkill(skill: ResolvedSkill): boolean {
  if (skill.inputSchema) return false; // structured schema → use data part
  const modes = skill.inputModes;
  if (!modes || modes.length === 0) return true; // no modes declared → default to text
  return modes.every((m) => m === 'text/plain');
}

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
      /** Human-readable status from the A2A agent (e.g. "querying data…"). */
      statusMessage?: string;
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
    /** A2A contextId for multi-turn session continuity. */
    contextId?: string;
    /** A2A taskId to continue a previous task conversation. */
    a2aTaskId?: string;
  }): Promise<A2ADispatchResponse>;

  /**
   * Re-query an in-flight A2A task by its remote task ID.
   * Returns a `final` response if the task has completed, or a
   * `task-handle` with the latest status if still running.
   * Implementors that do not support polling may omit this method.
   */
  getTask?(params: {
    agentUrl: string;
    a2aTaskId: string;
    auth?: AgentAuthProvider;
    correlationId: string;
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

    log.debug({ correlationId: context.correlationId, agentId: source.agentId, skillId: source.skillId, args }, '[invoke] tool call received');

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

    // 2. Session continuity: resolve contextId and running-task guard.
    const sessionId = context.sessionId ?? (typeof args['sessionId'] === 'string' ? args['sessionId'] : undefined);
    // Remove sessionId from dispatch args — it's a bridge concern, not agent input.
    const dispatchArgs = { ...(parsed.data as Record<string, unknown>) };
    delete dispatchArgs['sessionId'];

    // If caller supplied a sessionId, check for a still-running task on
    // the same session — reject so the LLM knows to wait or cancel first.
    if (sessionId) {
      const running = this.taskManager.findRunningByContext(sessionId);
      if (running) {
        const elapsedSec = Math.round((this.clock.now() - running.createdAt) / 1000);
        return {
          kind: 'error',
          error: {
            code: 'SESSION_TASK_RUNNING',
            message:
              `A previous task "${running.taskId}" on this session is still running ` +
              `(${elapsedSec}s elapsed). ` +
              `Wait for it to complete, or cancel it with the task_cancel tool ` +
              `using taskId "${running.taskId}".`,
            correlationId: context.correlationId,
            details: {
              sessionId,
              runningTaskId: running.taskId,
              elapsedSec,
            },
          },
        };
      }
    }

    // Resolve the A2A contextId and previous taskId for conversation continuity.
    const contextId = sessionId ?? undefined;
    let previousA2aTaskId: string | undefined;
    if (contextId) {
      const latest = this.taskManager.findLatestByContext(contextId);
      if (latest && latest.a2aTaskId && !latest.a2aTaskId.startsWith('pending:')) {
        previousA2aTaskId = latest.a2aTaskId;
      }
    }

    // 3. Dispatch to A2A agent.
    const start = this.clock.now();
    const auth = this.lookup.authFor(source.agentUrl);
    const useFallbackPath = isFallbackSkill(entry.skill) || isTextOnlySkill(entry.skill);
    log.debug({
      correlationId: context.correlationId,
      skillId: source.skillId,
      inputModes: entry.skill.inputModes,
      hasInputSchema: !!entry.skill.inputSchema,
      isFallback: isFallbackSkill(entry.skill),
      isTextOnly: isTextOnlySkill(entry.skill),
      dispatchPath: useFallbackPath ? 'text-part' : 'data-part',
      sessionId: contextId,
      previousA2aTaskId,
    }, '[invoke] dispatch decision');

    const dispatchPromise = this.dispatcher.dispatch({
      agentUrl: source.agentUrl,
      skillId: source.skillId,
      args: dispatchArgs,
      auth,
      correlationId: context.correlationId,
      fallback: useFallbackPath,
      contextId,
      a2aTaskId: previousA2aTaskId,
    });

    // -----------------------------------------------------------------------
    // Sync budget enforcement: if the agent doesn't respond within the
    // configured budget, return a task-handle immediately and let the
    // dispatch complete in the background.  The LLM can poll via
    // task_result / task_status which will re-query the agent.
    // A budget of 0 disables the deadline (wait forever).
    // -----------------------------------------------------------------------
    const budgetMs = context.syncBudgetMs;
    let response: A2ADispatchResponse;

    if (budgetMs > 0) {
      type RaceResult =
        | { timedOut: false; response: A2ADispatchResponse }
        | { timedOut: true };

      let raceResult: RaceResult;
      try {
        raceResult = await Promise.race<RaceResult>([
          dispatchPromise.then(
            (r): RaceResult => ({ timedOut: false, response: r }),
          ),
          new Promise<RaceResult>((resolve) => {
            setTimeout(() => resolve({ timedOut: true }), budgetMs);
          }),
        ]);
      } catch (err) {
        // Dispatch rejected before the timeout (e.g. network error).
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

      if (raceResult.timedOut) {
        return this.handleSyncBudgetExceeded(
          dispatchPromise,
          source,
          context,
          budgetMs,
          start,
        );
      }
      response = raceResult.response;
    } else {
      try {
        response = await dispatchPromise;
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
    }

    const durationMs = this.clock.now() - start;
    log.debug({ correlationId: context.correlationId, responseKind: response.kind, durationMs }, '[invoke] a2a response received');

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
      // Generate a sessionId for conversation continuity even on fast-path.
      const effectiveSessionId = contextId ?? randomUUID();
      const result: CanonicalResult = {
        status: 'success',
        sessionId: effectiveSessionId,
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
    const effectiveContextId = contextId ?? randomUUID();
    const task = this.taskManager.createTask(
      response.a2aTaskId,
      source.agentUrl,
      source.skillId,
      effectiveContextId,
    );

    // Persist the initial agent status message if present.
    if (response.statusMessage) {
      this.taskManager.updateStatusMessage(task.taskId, response.statusMessage);
    }

    // Build an instructive artifact so the LLM knows the task is pending
    // and which tool to call next.
    const statusHint = response.statusMessage
      ? ` Agent status: ${response.statusMessage}`
      : '';
    const pendingArtifact = {
      type: 'text/plain',
      data: `Task accepted and running (taskId: "${task.taskId}").${statusHint} ` +
        `Use the task_result tool with taskId "${task.taskId}" to retrieve the ` +
        `result when ready, or task_status to check progress.`,
    };

    log.debug({
      correlationId: context.correlationId,
      bridgeTaskId: task.taskId,
      a2aTaskId: response.a2aTaskId,
      statusMessage: response.statusMessage,
    }, '[invoke] long-path task created');

    const result: CanonicalResult = {
      status: 'success',
      taskId: task.taskId,
      taskState: task.state,
      sessionId: effectiveContextId,
      artifacts: [pendingArtifact],
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

  // -------------------------------------------------------------------------
  // Sync-budget timeout helpers
  // -------------------------------------------------------------------------

  /**
   * Called when `syncBudgetMs` expires before the dispatcher responds.
   * Creates a bridge task immediately and lets the dispatch promise settle
   * in the background so the result is available when the LLM polls.
   */
  private handleSyncBudgetExceeded(
    dispatchPromise: Promise<A2ADispatchResponse>,
    source: ToolSource,
    context: InvocationContext,
    budgetMs: number,
    startTs: number,
  ): InvocationOutcome {
    const durationMs = this.clock.now() - startTs;
    log.info({
      correlationId: context.correlationId,
      skillId: source.skillId,
      budgetMs,
      durationMs,
    }, '[invoke] sync budget exceeded — switching to long-path');

    // Create a bridge task with a placeholder a2aTaskId.  The background
    // handler will patch it to 'completed' (or 'failed') once the dispatch
    // settles.
    const PENDING_MARKER = 'pending:sync-budget-exceeded';
    const sessionId = context.sessionId ?? (typeof context.sessionId === 'string' ? context.sessionId : undefined);
    const effectiveContextId = sessionId ?? randomUUID();
    const task = this.taskManager.createTask(
      PENDING_MARKER,
      source.agentUrl,
      source.skillId,
      effectiveContextId,
    );

    // Fire-and-forget: let the dispatch resolve in the background.
    this.deferDispatchCompletion(
      task.taskId, dispatchPromise, source, context.correlationId,
    );

    const pendingArtifact = {
      type: 'text/plain',
      data:
        `The agent is still processing (exceeded ${budgetMs}ms sync budget). ` +
        `A background request is in flight.\n` +
        `Use the task_result tool with taskId "${task.taskId}" to retrieve ` +
        `the result when ready, or task_status to check progress.`,
    };

    const result: CanonicalResult = {
      status: 'success',
      taskId: task.taskId,
      taskState: task.state,
      sessionId: effectiveContextId,
      artifacts: [pendingArtifact],
      metadata: {
        agentUrl: source.agentUrl,
        skillId: source.skillId,
        durationMs,
        correlationId: context.correlationId,
      },
    };
    return { kind: 'long-path', result, bridgeTaskId: task.taskId };
  }

  /**
   * Attach a background handler to a still-in-flight dispatch promise.
   * When the promise settles, the bridge task is transitioned to its
   * terminal state so subsequent `task_result` calls return the answer.
   */
  private deferDispatchCompletion(
    bridgeTaskId: string,
    dispatchPromise: Promise<A2ADispatchResponse>,
    source: ToolSource,
    correlationId: string,
  ): void {
    dispatchPromise
      .then((response) => {
        if (response.kind === 'final') {
          const result: CanonicalResult = {
            status: 'success',
            artifacts: response.artifacts,
            metadata: {
              agentUrl: source.agentUrl,
              skillId: source.skillId,
              durationMs: 0,
              correlationId,
              ...(response.a2aTaskId ? { a2aTaskId: response.a2aTaskId } : {}),
            },
          };
          this.taskManager.updateTaskState(bridgeTaskId, {
            newState: 'completed',
            result,
          });
          log.info(
            { correlationId, bridgeTaskId },
            '[invoke] deferred dispatch completed — task updated',
          );
        } else if (response.kind === 'error') {
          this.taskManager.updateTaskState(bridgeTaskId, {
            newState: 'failed',
            error: {
              code: response.code,
              message: response.message,
              correlationId,
            },
          });
          log.warn(
            { correlationId, bridgeTaskId, error: response },
            '[invoke] deferred dispatch returned error',
          );
        } else {
          // task-handle: the agent itself is long-running *and* it took
          // longer than the sync budget just to acknowledge.  Rare, but
          // log it.  The task stays 'running' with a placeholder
          // a2aTaskId, so refreshTask will skip it gracefully.
          log.info(
            { correlationId, bridgeTaskId, a2aTaskId: response.a2aTaskId },
            '[invoke] deferred dispatch returned task-handle',
          );
        }
      })
      .catch((err) => {
        this.taskManager.updateTaskState(bridgeTaskId, {
          newState: 'failed',
          error: {
            code: 'A2A_PROTOCOL_ERROR',
            message: err instanceof Error ? err.message : String(err),
            correlationId,
          },
        });
        log.error(
          { correlationId, bridgeTaskId, err },
          '[invoke] deferred dispatch threw',
        );
      });
  }
}
