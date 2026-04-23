/**
 * Targeted branch-coverage tests for BridgeEngine: task.result on completed /
 * failed / cancelled states, task.cancel error paths, and response-mode
 * variations.
 */

import { describe, it, expect } from 'vitest';
import { createBridge } from '../../src/core/create-bridge.js';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
} from '../../src/core/invocation-runtime.js';
import type { BridgeConfig } from '../../src/config/schema.js';

const CARD = {
  name: 'agent-a',
  description: '',
  version: '1.0.0',
  url: 'https://agent-a.example.com',
  protocolVersion: '0.3.0',
  defaultInputModes: [],
  defaultOutputModes: [],
  skills: [
    {
      id: 'job',
      name: 'job',
      description: '',
      tags: [],
      inputSchema: { type: 'object', properties: {} },
    },
  ],
};

function baseConfig(
  overrides: Partial<BridgeConfig> = {},
): BridgeConfig {
  return {
    agents: [
      { url: 'https://agent-a.example.com', auth: { mode: 'none' } },
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

class LongPathStub implements A2ADispatcher {
  async dispatch(): Promise<A2ADispatchResponse> {
    return { kind: 'task-handle', a2aTaskId: 'remote-1' };
  }
}

class ErrorStub implements A2ADispatcher {
  async dispatch(): Promise<A2ADispatchResponse> {
    return {
      kind: 'error',
      code: 'AGENT_BOOM',
      message: 'remote error',
      details: { trace: 'x' },
    };
  }
}

class ThrowingStub implements A2ADispatcher {
  async dispatch(): Promise<A2ADispatchResponse> {
    throw new Error('network down');
  }
}

async function makeBridge(
  dispatcher: A2ADispatcher,
  overrides: Partial<BridgeConfig> = {},
) {
  const bridge = createBridge(baseConfig(overrides), {
    dispatcher,
    agentResolver: new AgentResolver({ fetcher: async () => CARD }),
  });
  await bridge.start();
  return bridge;
}

describe('BridgeEngine — task.result state branches', () => {
  it('returns the stored result when state=completed', async () => {
    const bridge = await makeBridge(new LongPathStub());
    const start = await bridge.engine.callTool('agent-a__job', {});
    const id = (start.structuredContent as Record<string, unknown>)[
      'taskId'
    ] as string;

    // Transition the task to completed via the TaskManager directly.
    const mgr = (bridge.engine as unknown as { taskManager: { updateTaskState: (id: string, p: { newState: string; result: unknown }) => void } }).taskManager;
    mgr.updateTaskState(id, {
      newState: 'completed',
      result: {
        status: 'success',
        artifacts: [{ type: 'application/json', data: { ok: true } }],
        metadata: {
          agentUrl: 'x',
          skillId: 's',
          durationMs: 0,
          correlationId: 'c',
        },
      },
    });

    const result = await bridge.engine.callTool('task_result', {
      taskId: id,
    });
    expect(result.isError).toBeUndefined();
    expect(
      (result.structuredContent as Record<string, unknown>)['status'],
    ).toBe('success');
  });

  it('returns TASK_FAILED when state=failed without error', async () => {
    const bridge = await makeBridge(new LongPathStub());
    const start = await bridge.engine.callTool('agent-a__job', {});
    const id = (start.structuredContent as Record<string, unknown>)[
      'taskId'
    ] as string;

    const mgr = (bridge.engine as unknown as { taskManager: { updateTaskState: (id: string, p: { newState: string }) => void } }).taskManager;
    mgr.updateTaskState(id, { newState: 'failed' });

    const result = await bridge.engine.callTool('task_result', {
      taskId: id,
    });
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as Record<string, Record<string, unknown>>)[
        'error'
      ]!['code'],
    ).toBe('TASK_FAILED');
  });

  it('returns TASK_CANCELLED when state=cancelled', async () => {
    const bridge = await makeBridge(new LongPathStub());
    const start = await bridge.engine.callTool('agent-a__job', {});
    const id = (start.structuredContent as Record<string, unknown>)[
      'taskId'
    ] as string;
    await bridge.engine.callTool('task_cancel', { taskId: id });

    const result = await bridge.engine.callTool('task_result', {
      taskId: id,
    });
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as Record<string, Record<string, unknown>>)[
        'error'
      ]!['code'],
    ).toBe('TASK_CANCELLED');
  });
});

describe('BridgeEngine — invocation error paths', () => {
  it('surfaces dispatcher returning error', async () => {
    const bridge = await makeBridge(new ErrorStub());
    const res = await bridge.engine.callTool('agent-a__job', {});
    expect(res.isError).toBe(true);
    expect(
      (res.structuredContent as Record<string, Record<string, unknown>>)[
        'error'
      ]!['code'],
    ).toBe('AGENT_BOOM');
  });

  it('wraps thrown dispatcher errors as A2A_PROTOCOL_ERROR', async () => {
    const bridge = await makeBridge(new ThrowingStub());
    const res = await bridge.engine.callTool('agent-a__job', {});
    expect(res.isError).toBe(true);
    expect(
      (res.structuredContent as Record<string, Record<string, unknown>>)[
        'error'
      ]!['code'],
    ).toBe('A2A_PROTOCOL_ERROR');
  });
});

describe('BridgeEngine — task.cancel on unknown / terminal', () => {
  it('returns error for task.cancel with empty taskId', async () => {
    const bridge = await makeBridge(new LongPathStub());
    const res = await bridge.engine.callTool('task_cancel', { taskId: '' });
    expect(res.isError).toBe(true);
    expect(
      (res.structuredContent as Record<string, Record<string, unknown>>)[
        'error'
      ]!['code'],
    ).toBe('VALIDATION_FAILED');
  });
});

describe('BridgeEngine — response mode variations', () => {
  it('compact mode returns a bounded text summary', async () => {
    const bridge = await makeBridge(
      {
        async dispatch(): Promise<A2ADispatchResponse> {
          return {
            kind: 'final',
            artifacts: [{ type: 'text', data: 'ok' }],
          };
        },
      },
      { responseMode: 'compact' },
    );
    const res = await bridge.engine.callTool('agent-a__job', {});
    const text = (res.content[0] as { text: string }).text;
    expect(text.length).toBeLessThanOrEqual(280);
  });

  it('raw mode emits byte-equivalent payload', async () => {
    const bridge = await makeBridge(
      {
        async dispatch(): Promise<A2ADispatchResponse> {
          return {
            kind: 'final',
            artifacts: [{ type: 'text', data: { v: 1 } }],
          };
        },
      },
      { responseMode: 'raw' },
    );
    const res = await bridge.engine.callTool('agent-a__job', {});
    expect((res.content[0] as { text: string }).text).toBe(
      JSON.stringify({ v: 1 }),
    );
  });
});
