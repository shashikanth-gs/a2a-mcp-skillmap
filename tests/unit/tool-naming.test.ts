import { describe, it, expect } from 'vitest';
import {
  DefaultToolNamingStrategy,
  MAX_MCP_TOOL_NAME_LENGTH,
} from '../../src/core/tool-naming.js';

const strat = new DefaultToolNamingStrategy();

describe('DefaultToolNamingStrategy', () => {
  it('produces {agentId}__{skillId} for clean inputs', () => {
    expect(strat.deriveName('agent', 'skill')).toBe('agent__skill');
  });

  it('sanitizes disallowed characters', () => {
    expect(strat.deriveName('agent.with.dots', 'skill/slash')).toBe(
      'agent_with_dots__skill_slash',
    );
  });

  it('falls back to hash for empty / unicode-only segments', () => {
    const name = strat.deriveName('', '🚀');
    expect(name.length).toBeGreaterThan(0);
    expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('truncates long names and preserves uniqueness via hash suffix', () => {
    const long = 'a'.repeat(100);
    const n1 = strat.deriveName(long, 'x');
    const n2 = strat.deriveName(long + 'b', 'x');
    expect(n1).not.toBe(n2);
    expect(n1.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
  });

  it('isValid checks format and length', () => {
    expect(strat.isValid('good-name_1')).toBe(true);
    expect(strat.isValid('')).toBe(false);
    expect(strat.isValid('bad space')).toBe(false);
    expect(strat.isValid('a'.repeat(MAX_MCP_TOOL_NAME_LENGTH + 1))).toBe(false);
    expect(strat.isValid(123 as unknown as string)).toBe(false);
  });

  it('deriveNameWithNamespace prefixes a hash of the agent URL', () => {
    const name = strat.deriveNameWithNamespace(
      'https://a.example.com',
      'agent',
      'skill',
    );
    expect(name.startsWith('ns')).toBe(true);
    expect(name).toContain('agent');
    expect(name).toContain('skill');
    expect(name.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
  });

  it('deriveNameWithNamespace truncates very long namespace segments', () => {
    const name = strat.deriveNameWithNamespace(
      'https://a.com',
      'a'.repeat(100),
      'b'.repeat(100),
    );
    expect(name.length).toBeLessThanOrEqual(MAX_MCP_TOOL_NAME_LENGTH);
  });

  it('truncates aggressively when maxLength is very small', () => {
    const tiny = new DefaultToolNamingStrategy(4);
    const name = tiny.deriveName('long-agent', 'long-skill');
    expect(name.length).toBeLessThanOrEqual(4);
  });
});
