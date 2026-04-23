/**
 * Skill implementations — all deterministic, no LLM, no user-supplied shell.
 *
 * The `run_command` skill uses an allowlist: only `date`, `uptime`, `whoami`,
 * `hostname`, `pwd` may run, and argv is hard-coded (no user input reaches
 * the process). This keeps the sample safe to run as-is in any environment.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type Command = 'date' | 'uptime' | 'whoami' | 'hostname' | 'pwd';
export const SUPPORTED_COMMANDS: Command[] = [
  'date',
  'uptime',
  'whoami',
  'hostname',
  'pwd',
];

interface CommandSpec {
  argv: string[];
}

/** Resolve the OS-appropriate argv for an allowlisted command. */
function resolveCommand(cmd: Command): CommandSpec {
  if (process.platform === 'win32') {
    switch (cmd) {
      case 'date':
        return { argv: ['cmd', '/c', 'echo', '%DATE% %TIME%'] };
      case 'uptime':
        return { argv: ['powershell', '-Command', '(Get-Uptime).ToString()'] };
      case 'whoami':
        return { argv: ['whoami'] };
      case 'hostname':
        return { argv: ['hostname'] };
      case 'pwd':
        return { argv: ['cmd', '/c', 'cd'] };
    }
  }
  switch (cmd) {
    case 'date':
      return { argv: ['date'] };
    case 'uptime':
      return { argv: ['uptime'] };
    case 'whoami':
      return { argv: ['whoami'] };
    case 'hostname':
      return { argv: ['hostname'] };
    case 'pwd':
      return { argv: ['pwd'] };
  }
}

/** Skill 1 — immediate Message reply with the current ISO timestamp. */
export function currentTime(): string {
  return new Date().toISOString();
}

/** Skill 2 — blocking task: run one allowlisted command, return stdout. */
export async function runCommand(cmd: Command): Promise<string> {
  const spec = resolveCommand(cmd);
  const [bin, ...args] = spec.argv;
  const { stdout } = await execFileAsync(bin!, args);
  return stdout.trim();
}

/** Skill 3 — streaming task: yields progress events as strings. */
export async function* slowReport(): AsyncGenerator<string, string, void> {
  yield 'collecting system info';
  const who = (await runCommand('whoami')).split('\n')[0] ?? '';
  yield `identified user: ${who}`;
  const host = (await runCommand('hostname')).split('\n')[0] ?? '';
  yield `identified host: ${host}`;
  const now = currentTime();
  yield `capturing timestamp: ${now}`;
  // Tiny deliberate pause so the client can see the intermediate states.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return `report: ${who}@${host} at ${now}`;
}
