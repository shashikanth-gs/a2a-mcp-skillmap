/**
 * End-to-end integration tests for the bridge pipeline.
 *
 * Uses a stub agent resolver + stub A2A dispatcher to exercise every layer
 * (registry → tool generation → invocation runtime → response projection →
 * task management) without network I/O.
 */

import { describe, it, expect } from 'vitest';
import { createBridge } from '../../src/core/create-bridge.js';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
} from '../../src/core/invocation-runtime.js';
import type { BridgeConfig } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function buildConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    agents: [
      {
        url: 'https://agent-a.example.com',
        auth: { mode: 'none' },
      },
      {
        url: 'https://agent-b.example.com',
        auth: { mode: 'none' },
      },
    ],
    transport: 'stdio',
    responseMode: 'structured',
    syncBudgetMs: 5000,
    taskRetentionMs: 3_600_000,
    retry: { maxAttempts: 1, initialDelayMs: 0 },
    logging: { level: 'error' },
    ...overrides,
  };
}

function stubCard(id: string, skills: string[]) {
  return {
    name: id,
    description: `agent ${id}`,
    version: '1.0.0',
    url: `https://${id}.example.com`,
    protocolVersion: '0.3.0',
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: skills.map((s) => ({
      id: s,
      name: s,
      description: `skill ${s}`,
      tags: [],
      inputSchema: {
        type: 'object',
        properties: { message: { type: 'string' } },
        required: ['message'],
      },
    })),
  };
}

class StubDispatcher implements A2ADispatcher {
  public calls: Array<{ agentUrl: string; skillId: string; args: unknown }> = [];
  constructor(
    private readonly responder: (params: {
      agentUrl: string;
      skillId: string;
    }) => A2ADispatchResponse,
  ) {}
  async dispatch(params: {
    agentUrl: string;
    skillId: string;
    args: Record<string, unknown>;
  }): Promise<A2ADispatchResponse> {
    this.calls.push({
      agentUrl: params.agentUrl,
      skillId: params.skillId,
      args: params.args,
    });
    return this.responder(params);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bridge pipeline — multi-agent resolution and tool listing', () => {
  it('projects one tool per skill across all agents', async () => {
    const cards = new Map<string, ReturnType<typeof stubCard>>([
      ['https://agent-a.example.com', stubCard('agent-a', ['echo', 'upper'])],
      ['https://agent-b.example.com', stubCard('agent-b', ['sum'])],
    ]);
    const resolver = new AgentResolver({
      fetcher: async (url) => cards.get(url)!,
    });
    const dispatcher = new StubDispatcher(() => ({
      kind: 'final',
      artifacts: [{ type: 'application/json', data: { ok: true } }],
    }));
    const bridge = createBridge(buildConfig(), {
      dispatcher,
      agentResolver: resolver,
    });
    await bridge.start();

    const tools = bridge.engine.listTools();
    // 3 skill tools + 3 task tools
    expect(tools).toHaveLength(6);
    const skillNames = tools
      .filter((t) => !t.name.startsWith('task_'))
      .map((t) => t.name)
      .sort();
    expect(skillNames).toEqual([
      'agent-a__echo',
      'agent-a__upper',
      'agent-b__sum',
    ]);
  });
});

describe('Bridge pipeline — fast-path invocation', () => {
  it('returns a structured CallToolResult for a successful invocation', async () => {
    const cards = new Map([
      [
        'https://agent-a.example.com',
        stubCard('agent-a', ['echo']),
      ],
      [
        'https://agent-b.example.com',
        stubCard('agent-b', ['ping']),
      ],
    ]);
    const resolver = new AgentResolver({
      fetcher: async (url) => cards.get(url)!,
    });
    const dispatcher = new StubDispatcher(() => ({
      kind: 'final',
      artifacts: [{ type: 'application/json', data: { reply: 'pong' } }],
    }));
    const bridge = createBridge(buildConfig(), {
      dispatcher,
      agentResolver: resolver,
    });
    await bridge.start();

    const result = await bridge.engine.callTool('agent-a__echo', {
      message: 'hi',
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      status: 'success',
      artifacts: [
        { type: 'application/json', data: { reply: 'pong' } },
      ],
    });
    expect(dispatcher.calls).toHaveLength(1);
    expect(dispatcher.calls[0]).toMatchObject({
      agentUrl: 'https://agent-a.example.com',
      skillId: 'echo',
      args: { message: 'hi' },
    });
  });
});

describe('Bridge pipeline — validation gate', () => {
  it('rejects invalid args before dispatching', async () => {
    const cards = new Map([
      [
        'https://agent-a.example.com',
        stubCard('agent-a', ['echo']),
      ],
      [
        'https://agent-b.example.com',
        stubCard('agent-b', ['ping']),
      ],
    ]);
    const resolver = new AgentResolver({
      fetcher: async (url) => cards.get(url)!,
    });
    const dispatcher = new StubDispatcher(() => ({
      kind: 'final',
      artifacts: [],
    }));
    const bridge = createBridge(buildConfig(), {
      dispatcher,
      agentResolver: resolver,
    });
    await bridge.start();

    const result = await bridge.engine.callTool('agent-a__echo', {
      message: 123, // wrong type
    } as unknown as Record<string, unknown>);

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: 'VALIDATION_FAILED' },
    });
    expect(dispatcher.calls).toHaveLength(0);
  });
});

describe('Bridge pipeline — long-running task lifecycle', () => {
  it('creates a task handle, reports status, and serves the final result', async () => {
    const cards = new Map([
      [
        'https://agent-a.example.com',
        stubCard('agent-a', ['long-job']),
      ],
      [
        'https://agent-b.example.com',
        stubCard('agent-b', ['ping']),
      ],
    ]);
    const resolver = new AgentResolver({
      fetcher: async (url) => cards.get(url)!,
    });

    // Initial dispatch returns a task handle (long path).
    const dispatcher = new StubDispatcher(() => ({
      kind: 'task-handle',
      a2aTaskId: 'remote-task-123',
    }));

    const bridge = createBridge(buildConfig(), {
      dispatcher,
      agentResolver: resolver,
    });
    await bridge.start();

    const start = await bridge.engine.callTool('agent-a__long-job', {
      message: 'go',
    });
    expect(start.isError).toBeUndefined();
    const structured = start.structuredContent as Record<string, unknown>;
    expect(structured['taskState']).toBe('running');
    const bridgeTaskId = structured['taskId'] as string;
    expect(bridgeTaskId).toBeTruthy();

    // task.status reports running.
    const status = await bridge.engine.callTool('task_status', {
      taskId: bridgeTaskId,
    });
    expect(
      (status.structuredContent as Record<string, unknown>)['taskState'],
    ).toBe('running');

    // task.result on running → "not yet available" indicator.
    const resultPending = await bridge.engine.callTool('task_result', {
      taskId: bridgeTaskId,
    });
    expect(resultPending.isError).toBeUndefined();
    const pending = resultPending.structuredContent as Record<string, unknown>;
    expect((pending['artifacts'] as Array<unknown>)[0]).toMatchObject({
      data: expect.objectContaining({ status: 'running' }),
    });

    // task.cancel transitions to cancelled.
    const cancelled = await bridge.engine.callTool('task_cancel', {
      taskId: bridgeTaskId,
    });
    expect(cancelled.isError).toBeUndefined();
    expect(
      (cancelled.structuredContent as Record<string, unknown>)['taskState'],
    ).toBe('cancelled');

    // Further cancel → error.
    const second = await bridge.engine.callTool('task_cancel', {
      taskId: bridgeTaskId,
    });
    expect(second.isError).toBe(true);
  });
});

describe('Bridge pipeline — error scenarios', () => {
  it('task.* with unknown taskId returns TASK_NOT_FOUND', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => stubCard('x', ['s']),
    });
    const dispatcher = new StubDispatcher(() => ({
      kind: 'final',
      artifacts: [],
    }));
    const bridge = createBridge(
      buildConfig({
        agents: [
          { url: 'https://agent-a.example.com', auth: { mode: 'none' } },
        ],
      }),
      { dispatcher, agentResolver: resolver },
    );
    await bridge.start();

    for (const tool of ['task_status', 'task_result', 'task_cancel']) {
      const res = await bridge.engine.callTool(tool, {
        taskId: '00000000-0000-0000-0000-000000000000',
      });
      expect(res.isError).toBe(true);
      expect(
        (res.structuredContent as Record<string, Record<string, unknown>>)[
          'error'
        ]!['code'],
      ).toBe('TASK_NOT_FOUND');
    }
  });

  it('unknown tool name returns TOOL_NOT_FOUND', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => stubCard('x', ['s']),
    });
    const dispatcher = new StubDispatcher(() => ({
      kind: 'final',
      artifacts: [],
    }));
    const bridge = createBridge(
      buildConfig({
        agents: [
          { url: 'https://agent-a.example.com', auth: { mode: 'none' } },
        ],
      }),
      { dispatcher, agentResolver: resolver },
    );
    await bridge.start();

    const res = await bridge.engine.callTool('does-not-exist', {});
    expect(res.isError).toBe(true);
    expect(
      (res.structuredContent as Record<string, Record<string, unknown>>)[
        'error'
      ]!['code'],
    ).toBe('TOOL_NOT_FOUND');
  });
});
