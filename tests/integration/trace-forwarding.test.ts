/**
 * End to end: a real MCP client calls the bridge, the bridge calls a real
 * (local, in-process) A2A sub-agent, and we check what the sub-agent receives.
 *
 * - `_meta.traceparent` path (what Copilot sends, any transport)
 * - HTTP `traceparent` header path (what Claude Code sends, HTTP only)
 * - nothing sent: previous behaviour, no trace headers invented
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createBridge } from '../../src/core/create-bridge.js';
import { createHttpAdapter, type HttpAdapter } from '../../src/mcp/http-server.js';
import { DefaultA2ADispatcher } from '../../src/a2a/dispatcher.js';
import { validateConfig } from '../../src/config/schema.js';

const TP = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const TRACE = '0af7651916cd43dd8448eb211c80319c';

interface Seen {
  headers: IncomingMessage['headers'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

/** A minimal A2A agent: serves a card and answers message/send, recording requests. */
async function startSubAgent(): Promise<{ url: string; seen: Seen[]; stop(): Promise<void> }> {
  const seen: Seen[] = [];
  let base = '';
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url?.includes('agent-card')) {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            name: 'agent-b',
            description: 'sub-agent',
            version: '1.0.0',
            url: base,
            protocolVersion: '0.3.0',
            capabilities: {},
            defaultInputModes: ['text'],
            defaultOutputModes: ['text'],
            skills: [{ id: 'echo', name: 'echo', description: 'echo', tags: [] }],
          }),
        );
        return;
      }
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      seen.push({ headers: req.headers, body });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: body?.id,
          result: { kind: 'message', messageId: 'reply', role: 'agent', parts: [{ kind: 'text', text: 'ok' }] },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url: base, seen, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function setup(propagation: Record<string, unknown> = {}) {
  const sub = await startSubAgent();
  cleanups.push(sub.stop);
  const config = validateConfig({
    agents: [{ url: sub.url }],
    transport: 'http',
    retry: { maxAttempts: 1, initialDelayMs: 0 },
    logging: { level: 'error' },
    propagation,
  });
  const bridge = createBridge(config, {
    dispatcher: new DefaultA2ADispatcher({
      propagation: {
        forwardTraceContext: config.propagation.forwardTraceContext,
        ...(config.propagation.parentAgentId ? { parentAgentId: config.propagation.parentAgentId } : {}),
        ...(config.propagation.propagatedMetadata ? { propagatedMetadata: config.propagation.propagatedMetadata } : {}),
      },
    }),
  });
  await bridge.start();
  cleanups.push(() => bridge.stop());
  const adapter: HttpAdapter = createHttpAdapter(bridge.engine, { port: 0 });
  await adapter.start();
  cleanups.push(() => adapter.stop());
  return { sub, bridge, adapter };
}

async function connect(adapter: HttpAdapter, headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${adapter.actualPort}/mcp`), {
    ...(headers ? { requestInit: { headers } } : {}),
  });
  await client.connect(transport);
  cleanups.push(() => client.close());
  return client;
}

async function callEcho(client: Client, meta?: Record<string, unknown>) {
  const tools = await client.listTools();
  const tool = tools.tools.find((t) => /echo|message/.test(t.name))!;
  expect(tool, `tools: ${tools.tools.map((t) => t.name).join(', ')}`).toBeDefined();
  const args = { message: 'hi' };
  return client.callTool({ name: tool.name, arguments: args, ...(meta ? { _meta: meta } : {}) });
}

describe('trace-context forwarding, end to end', () => {
  it('_meta.traceparent (Copilot) reaches the sub-agent as header and message metadata', async () => {
    const { sub, adapter } = await setup({ parentAgentId: 'orchestrator', propagatedMetadata: { tenant: 'acme' } });
    const client = await connect(adapter);
    const res = await callEcho(client, { traceparent: TP, tracestate: 'vendor=1' });
    expect(res.isError, JSON.stringify(res.content)).not.toBe(true);

    const req = sub.seen.at(-1)!;
    expect(req.headers['traceparent']).toBe(TP);
    expect(req.headers['tracestate']).toBe('vendor=1');
    expect(req.body.params.message.metadata).toEqual({
      traceparent: TP,
      tracestate: 'vendor=1',
      parent_agent_id: 'orchestrator',
      propagated_metadata: { tenant: 'acme' },
    });
  });

  it('HTTP traceparent header (Claude Code) reaches the sub-agent', async () => {
    const { sub, adapter } = await setup();
    const client = await connect(adapter, { traceparent: TP });
    await callEcho(client);
    const req = sub.seen.at(-1)!;
    expect(req.headers['traceparent']).toBe(TP);
    expect(req.body.params.message.metadata.traceparent).toBe(TP);
  });

  it('a call with no trace context sends none (previous behaviour)', async () => {
    const { sub, adapter } = await setup();
    const client = await connect(adapter);
    await callEcho(client);
    const req = sub.seen.at(-1)!;
    expect(req.headers['traceparent']).toBeUndefined();
    expect(req.body.params.message).not.toHaveProperty('metadata');
  });

  it('an invalid traceparent is ignored, not forwarded', async () => {
    const { sub, adapter } = await setup();
    const client = await connect(adapter);
    await callEcho(client, { traceparent: 'not-a-traceparent' });
    expect(sub.seen.at(-1)!.headers['traceparent']).toBeUndefined();
  });

  it('forwardTraceContext: false drops the trace but keeps attribution', async () => {
    const { sub, adapter } = await setup({ forwardTraceContext: false, parentAgentId: 'orchestrator' });
    const client = await connect(adapter);
    await callEcho(client, { traceparent: TP });
    const req = sub.seen.at(-1)!;
    expect(req.headers['traceparent']).toBeUndefined();
    expect(req.body.params.message.metadata).toEqual({ parent_agent_id: 'orchestrator' });
  });

  it('concurrent calls keep their own trace context', async () => {
    const { sub, adapter } = await setup();
    const client = await connect(adapter);
    const a = `00-${'a'.repeat(32)}-${'1'.repeat(16)}-01`;
    const b = `00-${'b'.repeat(32)}-${'2'.repeat(16)}-01`;
    await Promise.all([callEcho(client, { traceparent: a }), callEcho(client, { traceparent: b })]);
    const got = sub.seen.map((s) => s.headers['traceparent']).sort();
    expect(got).toEqual([a, b].sort());
    expect(TRACE).toBeTruthy();
  });
});
