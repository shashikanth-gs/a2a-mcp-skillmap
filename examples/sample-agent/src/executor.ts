/**
 * Agent executor — routes incoming A2A messages to a skill and publishes
 * the right event shape for each reply path:
 *
 *   current_time → immediate `Message` event (fast path, no Task)
 *   run_command  → Task → status(working) → artifact → status(completed)
 *   slow_report  → Task → repeated status(working, streamed progress) →
 *                  artifact → status(completed)
 *
 * Input discovery: bridge sends either a `data` part with
 * `{ skillId, args }` (normal skill invocation) or a `text` part (fallback
 * free-form message). Either way, we inspect the message and pick a branch.
 */

import { randomUUID } from 'node:crypto';
import type {
  AgentExecutor,
  ExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import type { Artifact, Message, TaskStatusUpdateEvent } from '@a2a-js/sdk';
import {
  currentTime,
  runCommand,
  slowReport,
  SUPPORTED_COMMANDS,
  type Command,
} from './skills.js';

// ---------------------------------------------------------------------------
// Shape of the routed call
// ---------------------------------------------------------------------------

type Routed =
  | { kind: 'current_time' }
  | { kind: 'run_command'; command: Command }
  | { kind: 'slow_report' }
  | { kind: 'unknown'; reason: string };

function routeMessage(msg: Message): Routed {
  for (const part of msg.parts) {
    if (part.kind === 'data') {
      const d = part.data as Record<string, unknown>;
      const skillId = d['skillId'];
      const args = (d['args'] as Record<string, unknown>) ?? {};
      if (skillId === 'current_time') return { kind: 'current_time' };
      if (skillId === 'slow_report') return { kind: 'slow_report' };
      if (skillId === 'run_command') {
        const cmd = args['command'];
        if (typeof cmd === 'string' && SUPPORTED_COMMANDS.includes(cmd as Command)) {
          return { kind: 'run_command', command: cmd as Command };
        }
        return {
          kind: 'unknown',
          reason: `run_command requires { command: ${SUPPORTED_COMMANDS.map((c) => `"${c}"`).join(' | ')} }`,
        };
      }
    }
    if (part.kind === 'text') {
      // Fallback-tool invocations arrive here. We treat them as current_time.
      return { kind: 'current_time' };
    }
  }
  return { kind: 'unknown', reason: 'no recognized skill in message parts' };
}

// ---------------------------------------------------------------------------
// Event helpers
// ---------------------------------------------------------------------------

function textArtifact(text: string): Artifact {
  return {
    artifactId: randomUUID(),
    parts: [{ kind: 'text', text }],
  };
}

function statusUpdate(
  taskId: string,
  contextId: string,
  state: 'working' | 'completed' | 'failed',
  note?: string,
  final = false,
): TaskStatusUpdateEvent {
  return {
    kind: 'status-update',
    taskId,
    contextId,
    final,
    status: {
      state,
      ...(note
        ? {
            message: {
              kind: 'message' as const,
              messageId: randomUUID(),
              role: 'agent' as const,
              parts: [{ kind: 'text' as const, text: note }],
              taskId,
              contextId,
            },
          }
        : {}),
      timestamp: new Date().toISOString(),
    },
  };
}

function replyMessage(
  contextId: string,
  taskId: string,
  text: string,
): Message {
  return {
    kind: 'message',
    messageId: randomUUID(),
    role: 'agent',
    parts: [{ kind: 'text', text }],
    taskId,
    contextId,
  };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export class SampleAgentExecutor implements AgentExecutor {
  // Tracks in-flight tasks so cancelTask() can short-circuit the stream.
  private readonly cancelled = new Set<string>();

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const routed = routeMessage(ctx.userMessage);

    // ---- Fast path: current_time replies immediately with a Message. No Task. ----
    if (routed.kind === 'current_time') {
      bus.publish(replyMessage(ctx.contextId, ctx.taskId, currentTime()));
      bus.finished();
      return;
    }

    // ---- Error path: unknown routing. Also a plain Message, no Task. ----
    if (routed.kind === 'unknown') {
      bus.publish(
        replyMessage(
          ctx.contextId,
          ctx.taskId,
          `sample-agent: ${routed.reason}`,
        ),
      );
      bus.finished();
      return;
    }

    // ---- Task path: both run_command and slow_report. ----
    // Emit initial Task in submitted state, then upgrade to working.
    bus.publish({
      kind: 'task',
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: {
        state: 'submitted',
        timestamp: new Date().toISOString(),
      },
    });

    try {
      if (routed.kind === 'run_command') {
        bus.publish(
          statusUpdate(
            ctx.taskId,
            ctx.contextId,
            'working',
            `running ${routed.command}`,
          ),
        );
        const stdout = await runCommand(routed.command);
        if (this.cancelled.has(ctx.taskId)) return;
        bus.publish({
          kind: 'artifact-update',
          taskId: ctx.taskId,
          contextId: ctx.contextId,
          artifact: textArtifact(stdout),
          lastChunk: true,
        });
        bus.publish(
          statusUpdate(
            ctx.taskId,
            ctx.contextId,
            'completed',
            `finished ${routed.command}`,
            true,
          ),
        );
      } else {
        // slow_report — streaming progress.
        const it = slowReport();
        while (true) {
          if (this.cancelled.has(ctx.taskId)) return;
          const next = await it.next();
          if (next.done) {
            bus.publish({
              kind: 'artifact-update',
              taskId: ctx.taskId,
              contextId: ctx.contextId,
              artifact: textArtifact(next.value),
              lastChunk: true,
            });
            bus.publish(
              statusUpdate(
                ctx.taskId,
                ctx.contextId,
                'completed',
                'report ready',
                true,
              ),
            );
            break;
          }
          bus.publish(
            statusUpdate(ctx.taskId, ctx.contextId, 'working', next.value),
          );
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bus.publish(
        statusUpdate(ctx.taskId, ctx.contextId, 'failed', msg, true),
      );
    } finally {
      bus.finished();
    }
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    this.cancelled.add(taskId);
    bus.publish({
      kind: 'status-update',
      taskId,
      contextId: taskId, // best-effort — real contextId is owned by the task
      final: true,
      status: {
        state: 'canceled',
        timestamp: new Date().toISOString(),
      },
    });
    bus.finished();
  }
}
