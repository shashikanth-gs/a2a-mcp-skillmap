/**
 * Sample A2A agent server — exposes three skills over JSON-RPC and the
 * well-known agent card, ready for the bridge to map into MCP tools.
 *
 * Run: `npm start` (from this directory) — listens on PORT (default 4003).
 */

import express from 'express';
import {
  DefaultRequestHandler,
  InMemoryTaskStore,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import type { AgentCard } from '@a2a-js/sdk';
import { SampleAgentExecutor } from './executor.js';
import { SUPPORTED_COMMANDS } from './skills.js';

const PORT = Number(process.env['PORT'] ?? 4003);
const HOST = process.env['HOST'] ?? '127.0.0.1';
const BASE_URL = `http://${HOST}:${PORT}`;

const AGENT_CARD: AgentCard = {
  name: 'sample-agent',
  description:
    'Deterministic, no-LLM sample agent exposing time + allowlisted shell commands over A2A.',
  version: '0.1.0',
  url: `${BASE_URL}/a2a/jsonrpc`,
  protocolVersion: '0.3.0',
  capabilities: {
    streaming: true,
    pushNotifications: false,
    stateTransitionHistory: false,
  },
  defaultInputModes: ['text', 'application/json'],
  defaultOutputModes: ['text'],
  skills: [
    {
      id: 'current_time',
      name: 'Current time',
      description: 'Returns the server-side current date and time as an ISO-8601 string.',
      tags: ['time', 'fast'],
      inputModes: ['application/json'],
      outputModes: ['text'],
    },
    {
      id: 'run_command',
      name: 'Run command',
      description: `Run one allowlisted read-only command and return stdout. Allowed: ${SUPPORTED_COMMANDS.join(', ')}.`,
      tags: ['shell', 'task'],
      inputModes: ['application/json'],
      outputModes: ['text'],
    },
    {
      id: 'slow_report',
      name: 'Slow report',
      description:
        'Streaming task that gathers user + host + timestamp, emitting working-state updates as it progresses.',
      tags: ['streaming', 'task', 'slow'],
      inputModes: ['application/json'],
      outputModes: ['text'],
    },
  ],
};

const executor = new SampleAgentExecutor();
const requestHandler = new DefaultRequestHandler(
  AGENT_CARD,
  new InMemoryTaskStore(),
  executor,
);

const app = express();
app.use(express.json());

app.use(
  '/.well-known/agent-card.json',
  agentCardHandler({ agentCardProvider: async () => AGENT_CARD }),
);
app.use(
  '/a2a/jsonrpc',
  jsonRpcHandler({
    requestHandler,
    userBuilder: UserBuilder.noAuthentication,
  }),
);

app.get('/health', (_req, res) => {
  res.json({ ok: true, agent: AGENT_CARD.name, version: AGENT_CARD.version });
});

app.listen(PORT, HOST, () => {
  console.log(`sample-agent listening on ${BASE_URL}`);
  console.log(`  agent card:   ${BASE_URL}/.well-known/agent-card.json`);
  console.log(`  JSON-RPC:     ${BASE_URL}/a2a/jsonrpc`);
  console.log(`  health:       ${BASE_URL}/health`);
  console.log(`  skills:       ${AGENT_CARD.skills.map((s) => s.id).join(', ')}`);
});
