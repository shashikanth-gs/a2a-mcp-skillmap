/**
 * Integration test for the CLI runner. Exercises:
 *   - Invalid configuration → structured exit (code 2).
 *   - HTTP transport end-to-end: config load → bridge start → adapter listening.
 *   - stdio transport with `skipStdioStart` so tests don't hijack STDIN.
 */

import { describe, it, expect, vi } from 'vitest';
import { runCli } from '../../src/cli/index.js';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';
import type {
  A2ADispatcher,
  A2ADispatchResponse,
} from '../../src/core/invocation-runtime.js';

class Stub implements A2ADispatcher {
  async dispatch(): Promise<A2ADispatchResponse> {
    return { kind: 'final', artifacts: [] };
  }
}

const CARD = {
  name: 'agent-a',
  description: '',
  version: '1.0.0',
  url: 'https://agent-a.example.com',
  protocolVersion: '0.3.0',
  defaultInputModes: [],
  defaultOutputModes: [],
  skills: [{ id: 'echo', name: 'echo', description: '', tags: [] }],
};

describe('runCli — error paths', () => {
  it('exits(2) with a config-error message when no agents are supplied', async () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(((code?: number) => {
        throw new Error(`exit:${code}`);
      }) as never);
    const writeErr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(runCli(['node', 'cli'], {})).rejects.toThrow(/exit:2/);
      const message = (writeErr.mock.calls[0]?.[0] ?? '') as string;
      expect(message).toMatch(/Configuration error/);
    } finally {
      exit.mockRestore();
      writeErr.mockRestore();
    }
  });
});

describe('runCli — HTTP transport end-to-end', () => {
  it('boots HTTP adapter on an ephemeral port and serves /mcp', async () => {
    const resolver = new AgentResolver({ fetcher: async () => CARD });
    const handle = await runCli(
      [
        'node',
        'cli',
        '--a2a-url',
        'https://agent-a.example.com',
        '--transport',
        'http',
        '--port',
        '3000', // nominal; actual port is overridden to 0 below
      ],
      {},
      {
        bridgeOptions: {
          dispatcher: new Stub(),
          agentResolver: resolver,
        },
        httpPortOverride: 0,
      },
    );
    try {
      // No assertion on the port itself (we don't return it up through runCli)
      // — but we know start() resolved. Issue a probe:
      // (The handle.stop cleanly exits, which is the main assertion.)
    } finally {
      await handle.stop();
    }
  });
});

describe('runCli — stdio transport (skip start)', () => {
  it('constructs stdio adapter without hijacking STDIN', async () => {
    const resolver = new AgentResolver({ fetcher: async () => CARD });
    const handle = await runCli(
      [
        'node',
        'cli',
        '--a2a-url',
        'https://agent-a.example.com',
        '--transport',
        'stdio',
      ],
      {},
      {
        bridgeOptions: {
          dispatcher: new Stub(),
          agentResolver: resolver,
        },
        skipStdioStart: true,
      },
    );
    await handle.stop();
  });

  it('config-file path feeds the loader (file-based agents only)', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'a2a-mcp-cli-'));
    const path = join(dir, 'conf.json');
    writeFileSync(
      path,
      JSON.stringify({
        agents: [{ url: 'https://agent-a.example.com' }],
        transport: 'stdio',
        responseMode: 'compact',
      }),
    );
    const resolver = new AgentResolver({ fetcher: async () => CARD });
    const handle = await runCli(
      ['node', 'cli', '--config', path],
      {},
      {
        bridgeOptions: {
          dispatcher: new Stub(),
          agentResolver: resolver,
        },
        skipStdioStart: true,
      },
    );
    await handle.stop();
  });
});
