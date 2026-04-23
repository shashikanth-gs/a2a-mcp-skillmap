import { describe, it, expect } from 'vitest';
import { ToolGenerator } from '../../src/core/tool-generator.js';
import type { ResolvedAgent, ToolNamingStrategy } from '../../src/types/index.js';

function agent(url: string, id: string, skillIds: string[]): ResolvedAgent {
  return {
    url,
    id,
    name: id,
    version: '1.0.0',
    description: '',
    skills: skillIds.map((sid) => ({
      id: sid,
      name: sid,
      description: '',
      tags: [],
      inputModes: [],
      outputModes: [],
      agentUrl: url,
      agentId: id,
    })),
    rawCard: {},
  };
}

describe('ToolGenerator', () => {
  it('resolves each generated tool back to its source', () => {
    const gen = new ToolGenerator();
    const decls = gen.generateTools([agent('https://a.com', 'a', ['x', 'y'])]);
    for (const d of decls) {
      expect(gen.resolveToolSource(d.name)).toEqual(d.metadata);
    }
    expect(gen.resolveToolSource('no-such')).toBeUndefined();
  });

  it('falls back to namespaced naming on collision', () => {
    // Two agents with different URLs but identical agentId+skillId would
    // collide under the default scheme; namespacing breaks the tie.
    const gen = new ToolGenerator();
    const decls = gen.generateTools([
      agent('https://a.com', 'same', ['x']),
      agent('https://b.com', 'same', ['x']),
    ]);
    expect(decls).toHaveLength(2);
    expect(new Set(decls.map((d) => d.name)).size).toBe(2);
  });

  it('honors a custom naming strategy', () => {
    const custom: ToolNamingStrategy = {
      deriveName: (a, s) => `custom-${a}-${s}`,
      isValid: () => true,
    };
    const gen = new ToolGenerator({ namingStrategy: custom });
    const [decl] = gen.generateTools([agent('https://x.com', 'a', ['s'])]);
    expect(decl?.name).toBe('custom-a-s');
  });

  it('generateTools can be called repeatedly with fresh state', () => {
    const gen = new ToolGenerator();
    gen.generateTools([agent('https://a.com', 'a', ['x'])]);
    const second = gen.generateTools([agent('https://a.com', 'a', ['y'])]);
    expect(second).toHaveLength(1);
    expect(second[0]?.name).toBe('a__y');
    expect(gen.resolveToolSource('a__x')).toBeUndefined();
  });
});
