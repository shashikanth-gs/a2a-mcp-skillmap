import { describe, it, expect } from 'vitest';
import {
  AgentRegistry,
  AgentRegistryError,
} from '../../src/core/registry.js';
import { AgentResolver } from '../../src/a2a/agent-resolver.js';

describe('AgentRegistry — retry + error handling', () => {
  const stubCard = {
    name: 'agent',
    description: 'd',
    version: '1.0.0',
    url: 'https://a.com',
    protocolVersion: '0.3.0',
    defaultInputModes: [],
    defaultOutputModes: [],
    skills: [{ id: 's', name: 's', tags: [] }],
  };

  it('retries transient failures up to maxAttempts', async () => {
    let attempt = 0;
    const resolver = new AgentResolver({
      fetcher: async () => {
        attempt++;
        if (attempt < 3) throw new Error('transient');
        return stubCard;
      },
    });
    const registry = new AgentRegistry({
      resolver,
      retry: { maxAttempts: 3, initialDelayMs: 0 },
      scheduler: { sleep: async () => {} },
    });
    registry.registerAgent({
      url: 'https://a.com',
      auth: { mode: 'none' },
    });

    const [agent] = await registry.resolveAll();
    expect(agent?.name).toBe('agent');
    expect(attempt).toBe(3);
  });

  it('fails after exhausting retry budget', async () => {
    const resolver = new AgentResolver({
      fetcher: async () => {
        throw new Error('dead');
      },
    });
    const registry = new AgentRegistry({
      resolver,
      retry: { maxAttempts: 2, initialDelayMs: 0 },
      scheduler: { sleep: async () => {} },
    });
    registry.registerAgent({
      url: 'https://a.com',
      auth: { mode: 'none' },
    });
    await expect(registry.resolveAll()).rejects.toBeInstanceOf(
      AgentRegistryError,
    );
  });

  it('refreshAgent replaces cached entry atomically', async () => {
    let callCount = 0;
    const resolver = new AgentResolver({
      fetcher: async () => {
        callCount++;
        return { ...stubCard, version: `1.0.${callCount}` };
      },
    });
    const registry = new AgentRegistry({
      resolver,
      retry: { maxAttempts: 1, initialDelayMs: 0 },
      scheduler: { sleep: async () => {} },
    });
    registry.registerAgent({
      url: 'https://a.com',
      auth: { mode: 'none' },
    });
    await registry.resolveAll();
    expect(registry.getAgent('https://a.com')?.version).toBe('1.0.1');
    await registry.refreshAgent('https://a.com');
    expect(registry.getAgent('https://a.com')?.version).toBe('1.0.2');
  });

  it('refreshAgent throws AGENT_UNKNOWN for unregistered URLs', async () => {
    const registry = new AgentRegistry({
      resolver: new AgentResolver({ fetcher: async () => stubCard }),
    });
    await expect(registry.refreshAgent('https://x.com')).rejects.toBeInstanceOf(
      AgentRegistryError,
    );
  });
});
