/**
 * BridgeEngine — central orchestrator. Owns AgentRegistry, ToolGenerator,
 * InvocationRuntime, TaskManager, and ResponseProjector. Exposes `listTools`
 * and `callTool` consumed by transport adapters.
 *
 * @module core/engine
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  AgentAuthProvider,
  AgentConfig,
  BridgeError,
  BridgeTask,
  CanonicalResult,
  ProjectionContext,
  ResolvedSkill,
  ResponseMode,
  ResponseProjector,
  ToolDeclaration,
  ToolSource,
} from '../types/index.js';
import { AgentRegistry } from './registry.js';
import { ToolGenerator } from './tool-generator.js';
import {
  InvocationRuntime,
  type A2ADispatcher,
  type SkillLookup,
} from './invocation-runtime.js';
import { TaskManager } from './task-manager.js';
import { DefaultResponseProjector } from './response-projector.js';
import { buildInputSchema } from '../a2a/skill-normalizer.js';
import {
  applyFallbackSkill,
  type FallbackMode,
} from './fallback-skill.js';

// ---------------------------------------------------------------------------
// Built-in task-management tools
// ---------------------------------------------------------------------------

// Task tool names use underscores (not dots) to satisfy the strictest MCP
// client name regex `^[a-z0-9_-]+$`. Dot-separated names like `task.status`
// are rejected by some clients (e.g., VS Code's MCP extension).
const TASK_STATUS_TOOL = 'task_status';
const TASK_RESULT_TOOL = 'task_result';
const TASK_CANCEL_TOOL = 'task_cancel';
const TASK_TOOLS = new Set([TASK_STATUS_TOOL, TASK_RESULT_TOOL, TASK_CANCEL_TOOL]);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface BridgeEngineOptions {
  registry: AgentRegistry;
  toolGenerator: ToolGenerator;
  dispatcher: A2ADispatcher;
  taskManager: TaskManager;
  projector?: ResponseProjector;
  responseMode?: ResponseMode;
  syncBudgetMs?: number;
  agentConfigs: AgentConfig[];
  authProviders?: Map<string, AgentAuthProvider>;
  fallbackTool?: FallbackMode;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class BridgeEngine {
  private readonly registry: AgentRegistry;
  private readonly toolGenerator: ToolGenerator;
  private readonly dispatcher: A2ADispatcher;
  private readonly taskManager: TaskManager;
  private readonly projector: ResponseProjector;
  private readonly responseMode: ResponseMode;
  private readonly syncBudgetMs: number;
  private readonly agentConfigs: AgentConfig[];
  private readonly authProviders: Map<string, AgentAuthProvider>;
  private readonly fallbackTool: FallbackMode;

  private tools: ToolDeclaration[] = [];
  private skillByTool = new Map<string, ResolvedSkill>();
  private runtime: InvocationRuntime;
  private initialized = false;

  constructor(options: BridgeEngineOptions) {
    this.registry = options.registry;
    this.toolGenerator = options.toolGenerator;
    this.dispatcher = options.dispatcher;
    this.taskManager = options.taskManager;
    this.projector = options.projector ?? new DefaultResponseProjector();
    this.responseMode = options.responseMode ?? 'artifact';
    this.syncBudgetMs = options.syncBudgetMs ?? 30_000;
    this.agentConfigs = options.agentConfigs;
    this.authProviders = options.authProviders ?? new Map();
    this.fallbackTool = options.fallbackTool ?? 'message';

    this.runtime = new InvocationRuntime({
      dispatcher: this.dispatcher,
      lookup: this.buildLookup(),
      taskManager: this.taskManager,
    });
  }

  async initialize(): Promise<void> {
    for (const cfg of this.agentConfigs) {
      this.registry.registerAgent(cfg);
    }
    const resolved = await this.registry.resolveAll();
    const agents = resolved.map((a) => applyFallbackSkill(a, this.fallbackTool));

    this.tools = this.toolGenerator.generateTools(agents);
    this.skillByTool = new Map();
    for (const decl of this.tools) {
      const source = decl.metadata;
      const agent = agents.find((a) => a.url === source.agentUrl);
      const skill = agent?.skills.find((s) => s.id === source.skillId);
      if (skill) this.skillByTool.set(decl.name, skill);
    }

    // Rebuild runtime with the now-populated lookup.
    this.runtime = new InvocationRuntime({
      dispatcher: this.dispatcher,
      lookup: this.buildLookup(),
      taskManager: this.taskManager,
    });

    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    // No active resources today — leave as a hook.
    this.initialized = false;
  }

  /**
   * Return all MCP tool declarations: skill-derived tools + the three
   * built-in task-management tools.
   */
  listTools(): ToolDeclaration[] {
    return [...this.tools, ...this.buildTaskTools()];
  }

  /** Execute a tool call, returning a ready-to-send `CallToolResult`. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const correlationId = randomUUID();
    const projectionContext: ProjectionContext = {
      mode: this.responseMode,
      toolName: name,
      correlationId,
    };

    if (TASK_TOOLS.has(name)) {
      return this.callTaskTool(name, args, projectionContext);
    }

    const source = this.toolGenerator.resolveToolSource(name);
    if (!source) {
      return this.errorResult(
        {
          code: 'TOOL_NOT_FOUND',
          message: `Unknown tool: ${name}`,
          correlationId,
        },
        projectionContext,
      );
    }

    const sessionId = typeof args['sessionId'] === 'string' ? args['sessionId'] : undefined;

    const outcome = await this.runtime.invoke(source, args, {
      correlationId,
      responseMode: this.responseMode,
      syncBudgetMs: this.syncBudgetMs,
      sessionId,
    });

    if (outcome.kind === 'error') {
      return this.errorResult(outcome.error, projectionContext);
    }
    return this.projector.project(outcome.result, projectionContext);
  }

  // -------------------------------------------------------------------------
  // Task tools
  // -------------------------------------------------------------------------

  private buildTaskTools(): ToolDeclaration[] {
    const schema = z.object({ taskId: z.string() });

    const mk = (n: string, d: string): ToolDeclaration => ({
      name: n,
      description: d,
      inputSchema: schema,
      metadata: { agentUrl: 'bridge://internal', agentId: 'bridge', skillId: n },
    });
    return [
      mk(
        TASK_STATUS_TOOL,
        'Check the current state of a long-running task. Waits briefly for the task to settle before responding. Returns the task state, elapsed time, and the latest agent status update if available.',
      ),
      mk(
        TASK_RESULT_TOOL,
        'Retrieve the result of a long-running task. Waits briefly for the task to complete before responding. If the task is still running, returns progress information — call again later to get the final answer.',
      ),
      mk(
        TASK_CANCEL_TOOL,
        'Cancel a running long-running task by its bridge taskId.',
      ),
    ];
  }

  private async callTaskTool(
    name: string,
    args: Record<string, unknown>,
    ctx: ProjectionContext,
  ): Promise<CallToolResult> {
    const taskId = typeof args['taskId'] === 'string' ? args['taskId'] : '';
    if (!taskId) {
      return this.errorResult(
        {
          code: 'VALIDATION_FAILED',
          message: 'taskId is required',
          correlationId: ctx.correlationId,
          details: {
            fields: [{ path: 'taskId', message: 'must be a non-empty string' }],
          },
        },
        ctx,
      );
    }

    const task = this.taskManager.getTask(taskId);
    if (!task) {
      return this.errorResult(
        {
          code: 'TASK_NOT_FOUND',
          message: `Unknown taskId: ${taskId}`,
          correlationId: ctx.correlationId,
          details: { taskId },
        },
        ctx,
      );
    }

    if (name === TASK_STATUS_TOOL) {
      // Wait for terminal state if still running, respecting the sync budget.
      if (task.state === 'running') {
        const settled = await this.waitForTaskSettlement(task, ctx.correlationId);
        if (settled) {
          const result: CanonicalResult = {
            status: 'success',
            taskId: settled.taskId,
            taskState: settled.state,
            sessionId: settled.contextId,
            artifacts: settled.result?.artifacts ?? [],
            metadata: {
              agentUrl: settled.agentUrl,
              skillId: settled.skillId,
              durationMs: 0,
              correlationId: ctx.correlationId,
              a2aTaskId: settled.a2aTaskId,
            },
          };
          return this.projector.project(result, ctx);
        }
        // Still running after budget — return a status message.
        const latest = this.taskManager.getTask(task.taskId);
        const elapsedSec = Math.round(
          (Date.now() - task.createdAt) / 1000,
        );
        const agentHint = latest?.statusMessage
          ? ` Agent status: ${latest.statusMessage}.`
          : '';
        const statusResult: CanonicalResult = {
          status: 'success',
          taskId: task.taskId,
          taskState: 'running',
          sessionId: task.contextId,
          artifacts: [
            {
              type: 'text/plain',
              data:
                `Task "${task.taskId}" is still running ` +
                `(${elapsedSec}s elapsed).${agentHint} ` +
                `The agent is processing the request in the background. ` +
                `Call task_result with this taskId to retrieve the answer once ready.`,
            },
          ],
          metadata: {
            agentUrl: task.agentUrl,
            skillId: task.skillId,
            durationMs: 0,
            correlationId: ctx.correlationId,
            a2aTaskId: task.a2aTaskId,
          },
        };
        return this.projector.project(statusResult, ctx);
      }
      const result: CanonicalResult = {
        status: 'success',
        taskId: task.taskId,
        taskState: task.state,
        sessionId: task.contextId,
        artifacts: task.result?.artifacts ?? [],
        metadata: {
          agentUrl: task.agentUrl,
          skillId: task.skillId,
          durationMs: 0,
          correlationId: ctx.correlationId,
          a2aTaskId: task.a2aTaskId,
        },
      };
      return this.projector.project(result, ctx);
    }

    if (name === TASK_RESULT_TOOL) {
      if (task.state === 'completed' && task.result) {
        return this.projector.project(task.result, ctx);
      }
      if (task.state === 'running') {
        // Wait for the task to settle, respecting the sync budget so the
        // LLM doesn't get an instant "still running" and hammer the tool.
        const settled = await this.waitForTaskSettlement(task, ctx.correlationId);
        if (settled?.state === 'completed' && settled.result) {
          return this.projector.project(settled.result, ctx);
        }
        if (settled?.state === 'failed') {
          const err = settled.error ?? {
            code: 'TASK_FAILED',
            message: `Task ${settled.taskId} failed`,
            correlationId: ctx.correlationId,
          };
          return this.errorResult(
            { code: err.code, message: err.message, correlationId: ctx.correlationId, details: { taskId } },
            ctx,
          );
        }
        // Still running after budget — tell the LLM.
        const latestTask = this.taskManager.getTask(task.taskId);
        const elapsedSec = Math.round(
          (Date.now() - task.createdAt) / 1000,
        );
        const agentHint = latestTask?.statusMessage
          ? ` Agent status: ${latestTask.statusMessage}.`
          : '';
        const pending: CanonicalResult = {
          status: 'success',
          taskId: task.taskId,
          taskState: 'running',
          sessionId: task.contextId,
          artifacts: [
            {
              type: 'text/plain',
              data:
                `Task "${task.taskId}" is still running ` +
                `(${elapsedSec}s elapsed).${agentHint} ` +
                `The agent is still processing. ` +
                `Call task_result again with this taskId to retrieve the answer once ready.`,
            },
          ],
          metadata: {
            agentUrl: task.agentUrl,
            skillId: task.skillId,
            durationMs: 0,
            correlationId: ctx.correlationId,
            a2aTaskId: task.a2aTaskId,
          },
        };
        return this.projector.project(pending, ctx);
      }
      // failed or cancelled
      const err = task.error ?? {
        code: task.state === 'cancelled' ? 'TASK_CANCELLED' : 'TASK_FAILED',
        message: `Task ${task.taskId} is ${task.state}`,
        correlationId: ctx.correlationId,
      };
      return this.errorResult(
        {
          code: err.code,
          message: err.message,
          correlationId: ctx.correlationId,
          details: { taskId },
        },
        ctx,
      );
    }

    // task.cancel
    try {
      const cancelled = await this.taskManager.cancelTask(taskId);
      const result: CanonicalResult = {
        status: 'success',
        taskId: cancelled.taskId,
        taskState: cancelled.state,
        artifacts: [],
        metadata: {
          agentUrl: cancelled.agentUrl,
          skillId: cancelled.skillId,
          durationMs: 0,
          correlationId: ctx.correlationId,
          a2aTaskId: cancelled.a2aTaskId,
        },
      };
      return this.projector.project(result, ctx);
    } catch (err) {
      return this.errorResult(
        {
          code:
            err instanceof Error && 'code' in err
              ? ((err as unknown as { code: string }).code ?? 'TASK_CANCEL_FAILED')
              : 'TASK_CANCEL_FAILED',
          message: err instanceof Error ? err.message : String(err),
          correlationId: ctx.correlationId,
          details: { taskId },
        },
        ctx,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Wait up to `syncBudgetMs` for a running task to reach a terminal state.
   *
   * For deferred dispatches (sync-budget exceeded on the initial call), the
   * background `deferDispatchCompletion` handler updates the local task
   * store — so we poll the store at short intervals.
   *
   * For tasks with a real A2A task ID, we also try `refreshTask()` to
   * actively re-query the remote agent.
   *
   * Returns the settled `BridgeTask` if it reached a terminal state within
   * the budget, or `undefined` if it's still running.
   */
  private async waitForTaskSettlement(
    task: BridgeTask,
    correlationId: string,
  ): Promise<BridgeTask | undefined> {
    const POLL_INTERVAL_MS = 2_000;
    const deadline = Date.now() + this.syncBudgetMs;

    while (Date.now() < deadline) {
      // Check if the background handler already settled the task.
      const current = this.taskManager.getTask(task.taskId);
      if (current && current.state !== 'running') {
        return current;
      }

      // Try an active re-query for tasks with a real A2A task ID.
      if (current) {
        const refreshed = await this.refreshTask(current, correlationId);
        if (refreshed && refreshed.state !== 'running') {
          return refreshed;
        }
      }

      // Wait before next poll, but don't overshoot the deadline.
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(POLL_INTERVAL_MS, remaining)));
    }

    // Final check after the budget.
    const final = this.taskManager.getTask(task.taskId);
    return final && final.state !== 'running' ? final : undefined;
  }

  /**
   * Re-query the remote A2A agent for the latest task state.
   * If the task has reached a terminal state, updates the local BridgeTask
   * store and returns the refreshed task. Returns `undefined` when the
   * dispatcher does not support `getTask()` or the query fails.
   */
  private async refreshTask(
    task: BridgeTask,
    correlationId: string,
  ): Promise<BridgeTask | undefined> {
    // Deferred dispatches (sync-budget exceeded) use a placeholder a2aTaskId.
    // The background handler will update the task when the dispatch settles;
    // we cannot re-query the agent without a real task ID.
    if (task.a2aTaskId.startsWith('pending:')) return undefined;
    if (!this.dispatcher.getTask) return undefined;
    try {
      const auth = this.authProviders.get(task.agentUrl);
      const fresh = await this.dispatcher.getTask({
        agentUrl: task.agentUrl,
        a2aTaskId: task.a2aTaskId,
        auth,
        correlationId,
      });

      if (fresh.kind === 'final') {
        const result: CanonicalResult = {
          status: 'success',
          artifacts: fresh.artifacts ?? [],
          metadata: {
            agentUrl: task.agentUrl,
            skillId: task.skillId,
            durationMs: 0,
            correlationId,
            a2aTaskId: task.a2aTaskId,
          },
        };
        return this.taskManager.updateTaskState(task.taskId, {
          newState: 'completed',
          result,
        });
      }

      if (fresh.kind === 'error') {
        return this.taskManager.updateTaskState(task.taskId, {
          newState: 'failed',
          error: {
            code: fresh.code,
            message: fresh.message,
            correlationId,
          },
        });
      }

      // Still running — persist the latest status message if available.
      if (fresh.statusMessage) {
        this.taskManager.updateStatusMessage(task.taskId, fresh.statusMessage);
      }
      return undefined;
    } catch {
      // getTask() failed (network, unsupported, …) — degrade gracefully.
      return undefined;
    }
  }

  private buildLookup(): SkillLookup {
    return {
      find: (source: ToolSource) => {
        // Find via our indexed name lookup first.
        for (const [, skill] of this.skillByTool) {
          if (
            skill.agentUrl === source.agentUrl &&
            skill.agentId === source.agentId &&
            skill.id === source.skillId
          ) {
            return { skill, inputSchema: buildInputSchema(skill) };
          }
        }
        return undefined;
      },
      authFor: (agentUrl: string) => this.authProviders.get(agentUrl),
    };
  }

  private errorResult(
    error: BridgeError,
    _ctx: ProjectionContext,
  ): CallToolResult {
    return {
      content: [
        {
          type: 'text',
          text: `Error [${error.code}]: ${error.message} (correlation ${error.correlationId})`,
        },
      ],
      isError: true,
      structuredContent: {
        error: {
          code: error.code,
          message: error.message,
          correlationId: error.correlationId,
          ...(error.details !== undefined ? { details: error.details } : {}),
        },
      },
    };
  }

  // Test-only: expose readiness state.
  get isInitialized(): boolean {
    return this.initialized;
  }
}
