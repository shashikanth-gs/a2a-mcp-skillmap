import { describe, it, expect } from 'vitest';
import { DefaultA2ADispatcher } from '../../src/a2a/dispatcher.js';
import type { A2AClient } from '@a2a-js/sdk/client';

/**
 * We exercise the dispatcher with a hand-rolled stub A2AClient so we can
 * assert how each SDK response shape is mapped to A2ADispatchResponse.
 */

interface StubSendResult {
  result?: { kind: 'task' | 'message'; [k: string]: unknown };
  error?: { code: number | string; message: string };
}

function stubClient(response: StubSendResult): A2AClient {
  return {
    sendMessage: async () => response,
  } as unknown as A2AClient;
}

describe('DefaultA2ADispatcher', () => {
  it('maps a running task response to a task-handle', async () => {
    const d = new DefaultA2ADispatcher({
      clientFactory: () =>
        stubClient({
          result: {
            kind: 'task',
            id: 'remote-1',
            status: { state: 'running' },
          },
        }),
    });
    const out = await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    expect(out).toEqual({ kind: 'task-handle', a2aTaskId: 'remote-1' });
  });

  it('maps a completed task response to a final result', async () => {
    const d = new DefaultA2ADispatcher({
      clientFactory: () =>
        stubClient({
          result: {
            kind: 'task',
            id: 'remote-2',
            status: { state: 'completed' },
            artifacts: [{ artifactId: 'a', parts: [] }],
          },
        }),
    });
    const out = await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    expect(out.kind).toBe('final');
  });

  it('maps a message response to a final result', async () => {
    const d = new DefaultA2ADispatcher({
      clientFactory: () =>
        stubClient({
          result: {
            kind: 'message',
            messageId: 'm',
            role: 'agent',
            parts: [],
          },
        }),
    });
    const out = await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    expect(out.kind).toBe('final');
  });

  it('maps an error response to A2ADispatchResponse.error', async () => {
    const d = new DefaultA2ADispatcher({
      clientFactory: () =>
        stubClient({
          error: { code: -32603, message: 'boom' },
        }),
    });
    const out = await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    expect(out).toMatchObject({ kind: 'error', message: 'boom' });
  });

  it('returns A2A_EMPTY_RESPONSE when result is missing', async () => {
    const d = new DefaultA2ADispatcher({
      clientFactory: () => stubClient({}),
    });
    const out = await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    expect(out).toEqual({
      kind: 'error',
      code: 'A2A_EMPTY_RESPONSE',
      message: 'empty response',
    });
  });

  it('returns A2A_UNKNOWN_RESULT for unexpected result kinds', async () => {
    const d = new DefaultA2ADispatcher({
      clientFactory: () =>
        stubClient({
          result: { kind: 'weird' } as unknown as {
            kind: 'task' | 'message';
          },
        }),
    });
    const out = await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    expect(out.kind).toBe('error');
  });

  it('passes auth-bag headers through the default client factory path', async () => {
    // We don't exercise the default factory (it would hit the network).
    // Instead, verify the dispatcher still resolves when auth is supplied
    // and the custom factory echoes it via the closure.
    let sawAuth = false;
    const d = new DefaultA2ADispatcher({
      clientFactory: (_url, auth) => {
        if (auth) sawAuth = true;
        return stubClient({
          result: {
            kind: 'task',
            id: 'r',
            status: { state: 'running' },
          },
        });
      },
    });
    await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
      auth: {
        applyAuth: () => {},
        redactedDescription: () => 'none',
      },
    });
    expect(sawAuth).toBe(true);
  });

  it('caches clients per agentUrl', async () => {
    let factoryCalls = 0;
    const d = new DefaultA2ADispatcher({
      clientFactory: () => {
        factoryCalls++;
        return stubClient({
          result: {
            kind: 'task',
            id: 'remote-x',
            status: { state: 'running' },
          },
        });
      },
    });
    await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    await d.dispatch({
      agentUrl: 'https://a.com',
      skillId: 's',
      args: {},
      correlationId: 'c',
    });
    expect(factoryCalls).toBe(1);
  });

  describe('part type selection', () => {
    function captureDispatcher() {
      let capturedParts: unknown[] = [];
      const d = new DefaultA2ADispatcher({
        clientFactory: () => ({
          sendMessage: async (req: { message: { parts: unknown[] } }) => {
            capturedParts = req.message.parts;
            return { result: { kind: 'message', messageId: 'm', role: 'agent', parts: [] } };
          },
        } as unknown as A2AClient),
      });
      return { d, getParts: () => capturedParts };
    }

    it('sends a text part when fallback=true with a message arg', async () => {
      const { d, getParts } = captureDispatcher();
      await d.dispatch({
        agentUrl: 'https://a.com',
        skillId: 's',
        args: { message: 'hello from text-only agent' },
        correlationId: 'c',
        fallback: true,
      });
      const parts = getParts() as Array<{ kind: string; text?: string }>;
      expect(parts).toHaveLength(1);
      expect(parts[0].kind).toBe('text');
      expect(parts[0].text).toBe('hello from text-only agent');
    });

    it('sends a text part when fallback=true with non-message args (JSON-serialized)', async () => {
      const { d, getParts } = captureDispatcher();
      await d.dispatch({
        agentUrl: 'https://a.com',
        skillId: 's',
        args: { query: 'error count', timeRange: '30m' },
        correlationId: 'c',
        fallback: true,
      });
      const parts = getParts() as Array<{ kind: string; text?: string }>;
      expect(parts[0].kind).toBe('text');
      expect(parts[0].text).toBe(JSON.stringify({ query: 'error count', timeRange: '30m' }));
    });

    it('sends a data part when fallback=false (normal structured skill)', async () => {
      const { d, getParts } = captureDispatcher();
      await d.dispatch({
        agentUrl: 'https://a.com',
        skillId: 'log-analysis',
        args: { message: 'check errors' },
        correlationId: 'c',
        fallback: false,
      });
      const parts = getParts() as Array<{ kind: string; data?: { skillId: string; args: unknown } }>;
      expect(parts).toHaveLength(1);
      expect(parts[0].kind).toBe('data');
      expect(parts[0].data?.skillId).toBe('log-analysis');
      expect(parts[0].data?.args).toEqual({ message: 'check errors' });
    });

    it('sends a data part when fallback is omitted (default)', async () => {
      const { d, getParts } = captureDispatcher();
      await d.dispatch({
        agentUrl: 'https://a.com',
        skillId: 's',
        args: {},
        correlationId: 'c',
      });
      const parts = getParts() as Array<{ kind: string }>;
      expect(parts[0].kind).toBe('data');
    });
  });
});
