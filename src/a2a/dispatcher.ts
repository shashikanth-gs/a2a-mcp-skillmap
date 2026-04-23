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
  }): Promise<A2ADispatchResponse> {
    const client = await this.getClient(params.agentUrl, params.auth);

    const messageId = randomUUID();
    // Fallback skill: send a plain-text part with the free-form message.
    // Normal skill: send a data part carrying skillId + args.
    const parts = params.fallback
      ? [
          {
            kind: 'text' as const,
            text: String(params.args['message'] ?? ''),
          },
        ]
      : [
          {
            kind: 'data' as const,
            data: { skillId: params.skillId, args: params.args },
          },
        ];
    const response = await client.sendMessage({
      message: {
        kind: 'message',
        messageId,
        role: 'user',
        parts,
      },
    });

    // SendMessageResponse is either { result: Message | Task } or { error: JSONRPCError }
    if ('error' in response && response.error) {
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

    // Task handle: kind === 'task' with status.state in {'running','submitted',...}
    if (result.kind === 'task') {
      const state = result.status?.state;
      if (state === 'completed') {
        return {
          kind: 'final',
          a2aTaskId: result.id,
          artifacts: (result.artifacts ?? []).map((a) => ({
            type: 'application/json',
            data: a,
          })),
        };
      }
      return { kind: 'task-handle', a2aTaskId: result.id };
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
