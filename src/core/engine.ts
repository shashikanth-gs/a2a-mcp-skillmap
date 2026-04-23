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

    const outcome = await this.runtime.invoke(source, args, {
      correlationId,
      responseMode: this.responseMode,
      syncBudgetMs: this.syncBudgetMs,
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
        'Poll the current state of a long-running task by its bridge taskId.',
      ),
      mk(
        TASK_RESULT_TOOL,
        'Retrieve the final result of a completed long-running task by its bridge taskId.',
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
      const result: CanonicalResult = {
        status: 'success',
        taskId: task.taskId,
        taskState: task.state,
        artifacts: [],
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
        const pending: CanonicalResult = {
          status: 'success',
          taskId: task.taskId,
          taskState: task.state,
          artifacts: [
            {
              type: 'application/json',
              data: {
                status: 'running',
                taskId: task.taskId,
                message: 'Task is still running. Poll again later.',
              },
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
