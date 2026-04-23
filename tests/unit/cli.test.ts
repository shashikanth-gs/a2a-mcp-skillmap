import { describe, it, expect } from 'vitest';
import { buildProgram } from '../../src/cli/index.js';

describe('CLI argument parsing', () => {
  it('parses repeatable --a2a-url', () => {
    const program = buildProgram();
    program.parse(
      [
        'node',
        'cli',
        '--a2a-url',
        'https://a.com',
        '--a2a-url',
        'https://b.com',
      ],
      { from: 'node' },
    );
    const opts = program.opts<{ a2aUrl: string[] }>();
    expect(opts.a2aUrl).toEqual(['https://a.com', 'https://b.com']);
  });

  it('accepts all declared transport options', () => {
    for (const t of ['stdio', 'http']) {
      const program = buildProgram();
      program.parse(['node', 'cli', '--transport', t], { from: 'node' });
      expect(program.opts<{ transport: string }>().transport).toBe(t);
    }
  });

  it('rejects invalid --transport values', () => {
    const program = buildProgram();
    program.exitOverride();
    expect(() =>
      program.parse(['node', 'cli', '--transport', 'bogus'], {
        from: 'user',
      }),
    ).toThrow();
  });

  it('parses --port as a number', () => {
    const program = buildProgram();
    program.parse(['node', 'cli', '--port', '8080'], { from: 'node' });
    expect(program.opts<{ port: number }>().port).toBe(8080);
  });
});
