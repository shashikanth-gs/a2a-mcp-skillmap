/**
 * Default A2A dispatcher backed by `@a2a-js/sdk`'s `A2AClient`. Translates
 * MCP tool invocations into A2A `message/send` requests and normalizes the
 * response into an {@link A2ADispatchResponse}.
 *
 * The dispatcher is transport-agnostic — it speaks JSON-RPC via the SDK.
 *
 * ### Card URL resolution
 *
 * The upstream SDK's `A2AClient.fromCardUrl()` expects the *full* card URL,
 * not the base URL. The bridge may be configured with either — and different
 * A2A deployments publish the card under different well-known paths. We
 * delegate to `resolveCardUrl()`, which probes `.well-known/agent-card.json`
 * then `.well-known/agent.json` (or accepts an explicit card URL as-is).
 *
 * @module a2a/dispatcher
 */

import { randomUUID } from 'node:crypto';
import { A2AClient } from '@a2a-js/sdk/client';
import type { AgentCard } from '@a2a-js/sdk';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
} from '../core/invocation-runtime.js';
import type { AgentAuthProvider } from '../types/index.js';
import { resolveCardUrl } from './card-url.js';
import { createLogger } from '../core/logger.js';

const log = createLogger({ level: 'debug' });

/** URI identifying A2A trace/telemetry sideband artifacts. */
const TRACE_EXTENSION_URI = 'urn:x-a2a:trace:v1';

/**
 * Returns true for artifacts tagged as observability sideband.
 * These should be forwarded to telemetry sinks, never to the MCP caller / LLM.
 */
function isTraceArtifact(artifact: unknown): boolean {
  if (!artifact || typeof artifact !== 'object') return false;
  const exts = (artifact as Record<string, unknown>)['extensions'];
  return Array.isArray(exts) && exts.includes(TRACE_EXTENSION_URI);
}

/**
 * Extract a plain-text status hint from an A2A task status message.
 * Returns `undefined` when there is nothing useful to surface.
 */
function extractStatusMessage(statusMsg: unknown): string | undefined {
  if (!statusMsg || typeof statusMsg !== 'object') return undefined;
  const parts = (statusMsg as Record<string, unknown>)['parts'];
  if (!Array.isArray(parts)) return undefined;
  const texts: string[] = [];
  for (const p of parts) {
    if (p && typeof p === 'object' && (p as Record<string, unknown>)['kind'] === 'text') {
      const t = (p as Record<string, unknown>)['text'];
      if (typeof t === 'string' && t.trim()) texts.push(t.trim());
    }
  }
  return texts.length > 0 ? texts.join(' ') : undefined;
}

/**
 * Build a `final` dispatch response from a completed A2A task, applying
 * trace-artifact filtering and the history-fallback heuristic.
 * Shared by `dispatch()` and `getTask()`.
 */
function buildCompletedResponse(
  result: { id: string; artifacts?: unknown[]; [k: string]: unknown },
  correlationId: string,
): A2ADispatchResponse {
  const allArtifacts: unknown[] = result.artifacts ?? [];

  const traceArtifacts = allArtifacts.filter(isTraceArtifact);
  const answerArtifacts = allArtifacts.filter((a) => !isTraceArtifact(a));

  if (traceArtifacts.length > 0) {
    log.debug({
      correlationId,
      traceCount: traceArtifacts.length,
      traceNames: traceArtifacts.map((a) => (a as Record<string, unknown>)['name']),
    }, '[dispatcher] sideband trace artifacts suppressed (not forwarded to MCP caller)');
  }

  let finalArtifacts = answerArtifacts;
  if (finalArtifacts.length === 0) {
    const history: unknown[] = (result as Record<string, unknown>)['history'] as unknown[] ?? [];
    const lastAgentMsg = [...history].reverse().find(
      (m) => (m as Record<string, unknown>)['role'] === 'agent',
    );
    if (lastAgentMsg) {
      log.debug({ correlationId }, '[dispatcher] no answer artifacts — using last history message as answer');
      finalArtifacts = [lastAgentMsg];
    }
  }

  log.debug({ correlationId, answerArtifactCount: finalArtifacts.length }, '[dispatcher] forwarding answer artifacts to MCP caller');

  return {
    kind: 'final',
    a2aTaskId: result.id,
    artifacts: finalArtifacts.map((a) => ({
      type: 'application/json',
      data: a,
    })),
  };
}

// ---------------------------------------------------------------------------
// Client cache
// ---------------------------------------------------------------------------

interface DispatcherOptions {
  /** Optional cache of pre-built A2AClient instances keyed by agent URL. */
  clientFactory?: (
    agentUrl: string,
    auth?: AgentAuthProvider,
  ) => Promise<A2AClient> | A2AClient;
}

export class DefaultA2ADispatcher implements A2ADispatcher {
  private readonly cache = new Map<string, Promise<A2AClient>>();
  private readonly clientFactory: (
    agentUrl: string,
    auth?: AgentAuthProvider,
  ) => Promise<A2AClient> | A2AClient;

  constructor(options: DispatcherOptions = {}) {
    this.clientFactory = options.clientFactory ?? defaultClientFactory;
  }

  async dispatch(params: {
    agentUrl: string;
    skillId: string;
    args: Record<string, unknown>;
    auth?: AgentAuthProvider;
    correlationId: string;
    fallback?: boolean;
    contextId?: string;
    a2aTaskId?: string;
  }): Promise<A2ADispatchResponse> {
    const client = await this.getClient(params.agentUrl, params.auth);

    const messageId = randomUUID();
    // Fallback skill / text-only skill: send a plain-text part.
    // Use the `message` field if present; otherwise JSON-serialize all args.
    // Normal skill: send a data part carrying skillId + args.
    const parts = params.fallback
      ? [
          {
            kind: 'text' as const,
            text: typeof params.args['message'] === 'string'
              ? params.args['message']
              : JSON.stringify(params.args),
          },
        ]
      : [
          {
            kind: 'data' as const,
            data: { skillId: params.skillId, args: params.args },
          },
        ];

    log.debug({
      correlationId: params.correlationId,
      agentUrl: params.agentUrl,
      skillId: params.skillId,
      partKind: parts[0].kind,
      partPayload: parts[0].kind === 'text'
        ? (parts[0] as { text: string }).text.slice(0, 200)
        : JSON.stringify((parts[0] as { data: unknown }).data).slice(0, 200),
    }, '[dispatcher] sending a2a message');
    const response = await client.sendMessage({
      message: {
        kind: 'message',
        messageId,
        role: 'user',
        parts,
        ...(params.contextId ? { contextId: params.contextId } : {}),
        ...(params.a2aTaskId ? { taskId: params.a2aTaskId } : {}),
      },
    });

    // SendMessageResponse is either { result: Message | Task } or { error: JSONRPCError }
    if ('error' in response && response.error) {
      log.warn({ correlationId: params.correlationId, error: response.error }, '[dispatcher] a2a error response');
      return {
        kind: 'error',
        code: String(response.error.code),
        message: response.error.message ?? 'A2A error',
      };
    }
    if (!('result' in response) || !response.result) {
      return { kind: 'error', code: 'A2A_EMPTY_RESPONSE', message: 'empty response' };
    }
    const result = response.result;
    log.debug({ correlationId: params.correlationId, resultKind: result.kind, taskState: (result as { status?: { state?: string } }).status?.state }, '[dispatcher] a2a result received');

    // Task handle: kind === 'task' with status.state in {'running','submitted',...}
    if (result.kind === 'task') {
      const state = result.status?.state;
      if (state === 'completed') {
        return buildCompletedResponse(
          result as unknown as { id: string; artifacts?: unknown[] },
          params.correlationId,
        );
      }
      const statusMessage = extractStatusMessage(result.status?.message);
      log.debug({
        correlationId: params.correlationId,
        a2aTaskId: result.id,
        state,
        statusMessage,
      }, '[dispatcher] task still in-flight — returning handle');
      return { kind: 'task-handle', a2aTaskId: result.id, statusMessage };
    }

    // Message: immediate reply treated as a fast-path final artifact.
    if (result.kind === 'message') {
      return {
        kind: 'final',
        artifacts: [
          {
            type: 'application/json',
            data: result,
          },
        ],
      };
    }

    return { kind: 'error', code: 'A2A_UNKNOWN_RESULT', message: 'unknown result kind' };
  }

  // -------------------------------------------------------------------------
  // Task re-query (tasks/get)
  // -------------------------------------------------------------------------

  async getTask(params: {
    agentUrl: string;
    a2aTaskId: string;
    auth?: AgentAuthProvider;
    correlationId: string;
  }): Promise<A2ADispatchResponse> {
    const client = await this.getClient(params.agentUrl, params.auth);

    log.debug({
      correlationId: params.correlationId,
      agentUrl: params.agentUrl,
      a2aTaskId: params.a2aTaskId,
    }, '[dispatcher] re-querying task via tasks/get');

    let task: unknown;
    try {
      task = await client.getTask({ id: params.a2aTaskId });
    } catch (err) {
      log.warn({ correlationId: params.correlationId, error: err }, '[dispatcher] tasks/get failed');
      return {
        kind: 'error',
        code: 'A2A_GET_TASK_FAILED',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (!task || typeof task !== 'object') {
      return { kind: 'error', code: 'A2A_EMPTY_RESPONSE', message: 'empty tasks/get response' };
    }

    const t = task as Record<string, unknown>;
    const status = t['status'] as { state?: string; message?: unknown } | undefined;
    const state = status?.state;

    log.debug({
      correlationId: params.correlationId,
      a2aTaskId: params.a2aTaskId,
      state,
    }, '[dispatcher] tasks/get result');

    if (state === 'completed') {
      return buildCompletedResponse(
        task as { id: string; artifacts?: unknown[] },
        params.correlationId,
      );
    }

    if (state === 'failed' || state === 'rejected') {
      const statusMessage = extractStatusMessage(status?.message);
      return {
        kind: 'error',
        code: state === 'failed' ? 'A2A_TASK_FAILED' : 'A2A_TASK_REJECTED',
        message: statusMessage ?? `Task ${state}`,
      };
    }

    if (state === 'canceled') {
      return {
        kind: 'error',
        code: 'A2A_TASK_CANCELLED',
        message: 'Task was cancelled by the agent',
      };
    }

    // Still in-flight (submitted, working, input-required, auth-required, …)
    const statusMessage = extractStatusMessage(status?.message);
    return { kind: 'task-handle', a2aTaskId: params.a2aTaskId, statusMessage };
  }

  private async getClient(
    agentUrl: string,
    auth?: AgentAuthProvider,
  ): Promise<A2AClient> {
    let existing = this.cache.get(agentUrl);
    if (!existing) {
      existing = Promise.resolve(this.clientFactory(agentUrl, auth));
      this.cache.set(agentUrl, existing);
    }
    return existing;
  }
}

async function defaultClientFactory(
  agentUrl: string,
  auth?: AgentAuthProvider,
): Promise<A2AClient> {
  const fetchImpl: typeof fetch = auth
    ? (async (input, init) => {
        const headers = new Headers(init?.headers ?? {});
        const bag: Record<string, string> = {};
        auth.applyAuth(bag);
        for (const [k, v] of Object.entries(bag)) headers.set(k, v);
        return fetch(input, { ...init, headers });
      }) as typeof fetch
    : fetch;

  // Probe well-known paths (or use the explicit URL if the caller supplied one).
  const { cardText } = await resolveCardUrl(agentUrl, fetchImpl);
  const agentCard = JSON.parse(cardText) as AgentCard;
  return new A2AClient(agentCard, { fetchImpl });
}
