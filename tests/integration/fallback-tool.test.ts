/**
 * Integration test for the zero-skill agent fallback.
 *
 * Asserts that:
 *   1. When an agent card advertises zero skills and fallbackTool='message'
 *      (default), a single synthesized tool appears in listTools().
 *   2. The tool's description carries the agent name + description so an MCP
 *      client can identify what the tool talks to, even without invoking it.
 *   3. Calling the tool dispatches with fallback=true — the dispatcher
 *      receives a plain `message` arg, not a wrapped skill-args payload.
 *   4. With fallbackTool='none', zero skills → zero skill-tools (only the
 *      three built-in task.* tools remain).
 */

import { describe, it, expect } from 'vitest';
import { createBridge } from '../../src/core/create-bridge.js';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
} from '../../src/core/invocation-runtime.js';
import type { BridgeConfig } from '../../src/config/schema.js';

const ZERO_SKILL_CARD = {
  name: 'dumb agent',
  description: 'just a stub',
  version: '1.0.0',
  url: 'http://localhost:4003',
  protocolVersion: '0.3.0',
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
  skills: [] as unknown[],
};

function baseConfig(
  fallback: 'message' | 'none',
): BridgeConfig {
  return {
    agents: [{ url: 'http://localhost:4003', auth: { mode: 'none' } }],
    transport: 'stdio',
    responseMode: 'structured',
    fallbackTool: fallback,
    syncBudgetMs: 5000,
    taskRetentionMs: 3_600_000,
    retry: { maxAttempts: 1, initialDelayMs: 0 },
    logging: { level: 'error' },
  };
}

class RecordingDispatcher implements A2ADispatcher {
  public calls: Array<{
    skillId: string;
    args: Record<string, unknown>;
    fallback?: boolean;
  }> = [];
  async dispatch(params: {
    skillId: string;
    args: Record<string, unknown>;
    fallback?: boolean;
  }): Promise<A2ADispatchResponse> {
    this.calls.push({
      skillId: params.skillId,
      args: params.args,
      ...(params.fallback !== undefined ? { fallback: params.fallback } : {}),
    });
    return {
      kind: 'final',
      artifacts: [{ type: 'application/json', data: { ok: true } }],
    };
  }
}

describe('fallback tool — zero-skill agent', () => {
  it('synthesizes a message tool with agent identity in the description', async () => {
    const bridge = createBridge(baseConfig('message'), {
      dispatcher: new RecordingDispatcher(),
      agentResolver: new AgentResolver({
        fetcher: async () => ZERO_SKILL_CARD,
      }),
    });
    await bridge.start();

    const tools = bridge.engine.listTools();
    const skillTools = tools.filter((t) => !t.name.startsWith('task_'));
    expect(skillTools).toHaveLength(1);

    const fallback = skillTools[0]!;
    expect(fallback.name).toBe('dumb_agent__message');
    expect(fallback.description).toContain('dumb agent');
    expect(fallback.description).toContain('just a stub');
    expect(fallback.description).toContain('no skills');
  });

  it('invoking the fallback tool dispatches with fallback=true', async () => {
    const dispatcher = new RecordingDispatcher();
    const bridge = createBridge(baseConfig('message'), {
      dispatcher,
      agentResolver: new AgentResolver({
        fetcher: async () => ZERO_SKILL_CARD,
      }),
    });
    await bridge.start();

    const result = await bridge.engine.callTool('dumb_agent__message', {
      message: 'hello, dumb agent',
    });
    expect(result.isError).toBeUndefined();
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]).toMatchObject({
      skillId: 'message',
      args: { message: 'hello, dumb agent' },
      fallback: true,
    });
  });

  it('rejects invalid args before dispatch (validation gate still applies)', async () => {
    const dispatcher = new RecordingDispatcher();
    const bridge = createBridge(baseConfig('message'), {
      dispatcher,
      agentResolver: new AgentResolver({
        fetcher: async () => ZERO_SKILL_CARD,
      }),
    });
    await bridge.start();

    const result = await bridge.engine.callTool('dumb_agent__message', {
      message: 123, // wrong type
    } as unknown as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(dispatcher.calls).toHaveLength(0);
  });

  it('fallbackTool=none leaves zero-skill agents with no skill-tools', async () => {
    const bridge = createBridge(baseConfig('none'), {
      dispatcher: new RecordingDispatcher(),
      agentResolver: new AgentResolver({
        fetcher: async () => ZERO_SKILL_CARD,
      }),
    });
    await bridge.start();
    const tools = bridge.engine.listTools();
    const skillTools = tools.filter((t) => !t.name.startsWith('task_'));
    expect(skillTools).toHaveLength(0);
  });
});
