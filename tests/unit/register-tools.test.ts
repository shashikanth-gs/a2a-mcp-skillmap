/**
 * Unit test for `registerBridgeTools`. We exercise the callback wiring so
 * that both the ZodObject branch and the primitive-schema wrap branch are
 * covered.
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerBridgeTools } from '../../src/mcp/register-tools.js';
import type { BridgeEngine } from '../../src/core/engine.js';
import type { ToolDeclaration } from '../../src/types/index.js';

class FakeEngine {
  constructor(private readonly tools: ToolDeclaration[]) {}
  listTools() {
    return this.tools;
  }
  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: 'text'; text: string }>; structuredContent: unknown }> {
    return {
      content: [{ type: 'text', text: `${name}:${JSON.stringify(args)}` }],
      structuredContent: { name, args },
    };
  }
}

describe('registerBridgeTools', () => {
  it('registers object-schema tools and primitive-schema tools and invokes callbacks', async () => {
    const tools: ToolDeclaration[] = [
      {
        name: 'obj-tool',
        description: 'object',
        inputSchema: z.object({ x: z.string() }),
        metadata: { agentUrl: 'x', agentId: 'a', skillId: 's' },
      },
      {
        name: 'prim-tool',
        description: 'primitive',
        inputSchema: z.string(),
        metadata: { agentUrl: 'x', agentId: 'a', skillId: 's' },
      },
    ];
    const engine = new FakeEngine(tools) as unknown as BridgeEngine;

    // Capture the callbacks by passing a fake server that records them.
    const recorded: Array<{
      name: string;
      cb: (args: unknown) => Promise<unknown>;
    }> = [];
    const fakeServer = {
      registerTool: (
        name: string,
        _cfg: unknown,
        cb: (args: unknown) => Promise<unknown>,
      ) => {
        recorded.push({ name, cb });
      },
    } as unknown as McpServer;

    registerBridgeTools(fakeServer, engine);
    expect(recorded).toHaveLength(2);

    // Exercise both callbacks — once with an object arg (covers the "record"
    // branch) and once with a non-object arg (covers the `{}` fallback).
    const first = await recorded[0]!.cb({ x: 'hello' });
    expect(first).toBeDefined();
    const second = await recorded[1]!.cb('not-an-object');
    expect(second).toBeDefined();
  });
});
