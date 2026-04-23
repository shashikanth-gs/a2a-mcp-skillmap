import { describe, it, expect } from 'vitest';
import {
  AgentResolver,
  AgentResolutionError,
} from '../../src/a2a/agent-resolver.js';
import { BearerAgentAuth } from '../../src/auth/outbound/index.js';

const validCard = {
  name: 'agent',
  description: 'd',
  version: '1.0.0',
  url: 'https://a.com',
  protocolVersion: '0.3.0',
  defaultInputModes: ['application/json'],
  defaultOutputModes: ['application/json'],
  skills: [
    {
      id: 's',
      name: 'skill',
      description: 'sd',
      tags: ['util'],
    },
  ],
};

describe('AgentResolver', () => {
  it('wraps fetcher errors as AGENT_FETCH_FAILED', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => {
        throw new Error('network');
      },
    });
    await expect(resolver.resolve('https://a.com')).rejects.toMatchObject({
      name: 'AgentResolutionError',
      code: 'AGENT_FETCH_FAILED',
    });
  });

  it('rejects null/undefined card with AGENT_CARD_EMPTY', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => null,
    });
    await expect(resolver.resolve('https://a.com')).rejects.toMatchObject({
      code: 'AGENT_CARD_EMPTY',
    });
  });

  it('rejects malformed card with AGENT_CARD_INVALID', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => ({ name: '' }),
    });
    await expect(resolver.resolve('https://a.com')).rejects.toMatchObject({
      code: 'AGENT_CARD_INVALID',
    });
  });

  it('resolves a valid card through the auth-wrapping fetcher', async () => {
    let sawAuth: AgentAuthMarker | null = null;
    const resolver = new AgentResolver({
      fetcher: async (_url, auth) => {
        sawAuth = auth ? { desc: auth.redactedDescription() } : null;
        return validCard;
      },
    });
    const auth = new BearerAgentAuth('tok');
    const agent = await resolver.resolve('https://a.com', auth);
    expect(agent.name).toBe('agent');
    expect(agent.skills).toHaveLength(1);
    expect(sawAuth).not.toBeNull();
    expect(sawAuth!.desc).toContain('[REDACTED]');
  });

  it('accepts the structured { cardUrl, raw } fetcher return', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => ({
        cardUrl: 'https://a.com/.well-known/agent-card.json',
        raw: validCard,
      }),
    });
    const agent = await resolver.resolve('https://a.com');
    expect(agent.cardUrl).toBe('https://a.com/.well-known/agent-card.json');
    expect(agent.name).toBe('agent');
  });

  it('falls back to input URL as cardUrl when fetcher returns a bare card', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => validCard,
    });
    const agent = await resolver.resolve('https://a.com/custom-card.json');
    expect(agent.cardUrl).toBe('https://a.com/custom-card.json');
  });

  it('AgentResolutionError is an Error subclass with the documented fields', () => {
    const err = new AgentResolutionError(
      'msg',
      'AGENT_FETCH_FAILED',
      'https://a.com',
      'cause',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.agentUrl).toBe('https://a.com');
    expect(err.cause).toBe('cause');
  });
});

interface AgentAuthMarker {
  desc: string;
}
