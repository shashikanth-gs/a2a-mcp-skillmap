import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadConfig,
  redactConfig,
  ConfigLoadError,
} from '../../src/config/loader.js';
import type { BridgeConfig } from '../../src/config/schema.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `config-loader-test-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeJsonFile(name: string, data: unknown): string {
  const filePath = join(tmpDir, name);
  writeFileSync(filePath, JSON.stringify(data));
  return filePath;
}

const MINIMAL_AGENTS = [{ url: 'https://agent.example.com' }];

// ---------------------------------------------------------------------------
// loadConfig — config file source
// ---------------------------------------------------------------------------

describe('loadConfig — config file', () => {
  it('loads and validates a minimal config file', () => {
    const filePath = writeJsonFile('config.json', { agents: MINIMAL_AGENTS });
    const config = loadConfig({ filePath });

    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].url).toBe('https://agent.example.com');
    expect(config.transport).toBe('stdio');
  });

  it('throws ConfigLoadError when file does not exist', () => {
    expect(() =>
      loadConfig({ filePath: '/nonexistent/path/config.json' }),
    ).toThrow(ConfigLoadError);

    try {
      loadConfig({ filePath: '/nonexistent/path/config.json' });
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      expect((err as ConfigLoadError).code).toBe('CONFIG_FILE_READ_ERROR');
    }
  });

  it('throws ConfigLoadError when file is not valid JSON', () => {
    const filePath = join(tmpDir, 'bad.json');
    writeFileSync(filePath, '{ not json }');

    expect(() => loadConfig({ filePath })).toThrow(ConfigLoadError);
    try {
      loadConfig({ filePath });
    } catch (err) {
      expect((err as ConfigLoadError).code).toBe('CONFIG_FILE_PARSE_ERROR');
    }
  });

  it('throws ConfigLoadError with field details on validation failure', () => {
    const filePath = writeJsonFile('empty.json', {});

    try {
      loadConfig({ filePath });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigLoadError);
      const cle = err as ConfigLoadError;
      expect(cle.code).toBe('CONFIG_VALIDATION_ERROR');
      expect(cle.details.fields).toBeDefined();
      expect(cle.details.fields!.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig — environment variables
// ---------------------------------------------------------------------------

describe('loadConfig — environment variables', () => {
  it('maps A2A_MCP_AGENTS to agents array', () => {
    const config = loadConfig({
      env: { A2A_MCP_AGENTS: 'https://a.com,https://b.com' },
    });
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0].url).toBe('https://a.com');
    expect(config.agents[1].url).toBe('https://b.com');
  });

  it('maps scalar env vars to config fields', () => {
    const config = loadConfig({
      env: {
        A2A_MCP_AGENTS: 'https://a.com',
        A2A_MCP_TRANSPORT: 'http',
        A2A_MCP_PORT: '9090',
        A2A_MCP_RESPONSE_MODE: 'compact',
        A2A_MCP_SYNC_BUDGET_MS: '5000',
        A2A_MCP_TASK_RETENTION_MS: '7200000',
        A2A_MCP_LOG_LEVEL: 'debug',
        A2A_MCP_RETRY_MAX_ATTEMPTS: '5',
        A2A_MCP_RETRY_INITIAL_DELAY_MS: '1000',
      },
    });

    expect(config.transport).toBe('http');
    expect(config.http?.port).toBe(9090);
    expect(config.responseMode).toBe('compact');
    expect(config.syncBudgetMs).toBe(5000);
    expect(config.taskRetentionMs).toBe(7200000);
    expect(config.logging.level).toBe('debug');
    expect(config.retry.maxAttempts).toBe(5);
    expect(config.retry.initialDelayMs).toBe(1000);
  });

  it('maps inbound auth env vars', () => {
    const config = loadConfig({
      env: {
        A2A_MCP_AGENTS: 'https://a.com',
        A2A_MCP_INBOUND_AUTH_MODE: 'bearer',
        A2A_MCP_INBOUND_AUTH_TOKEN: 'secret-token',
        A2A_MCP_INBOUND_AUTH_HEADER: 'Authorization',
      },
    });

    expect(config.http?.inboundAuth.mode).toBe('bearer');
    expect(config.http?.inboundAuth.token).toBe('secret-token');
    expect(config.http?.inboundAuth.headerName).toBe('Authorization');
  });

  it('ignores undefined env vars without overriding', () => {
    const filePath = writeJsonFile('config.json', {
      agents: MINIMAL_AGENTS,
      transport: 'http',
    });

    const config = loadConfig({
      filePath,
      env: { A2A_MCP_TRANSPORT: undefined },
    });

    expect(config.transport).toBe('http');
  });
});

// ---------------------------------------------------------------------------
// loadConfig — CLI flags
// ---------------------------------------------------------------------------

describe('loadConfig — CLI flags', () => {
  it('applies CLI flags as highest precedence', () => {
    const filePath = writeJsonFile('config.json', {
      agents: MINIMAL_AGENTS,
      transport: 'stdio',
      responseMode: 'raw',
    });

    const config = loadConfig({
      filePath,
      env: { A2A_MCP_TRANSPORT: 'http', A2A_MCP_RESPONSE_MODE: 'compact' },
      cli: { transport: 'stdio', responseMode: 'structured' },
    });

    // CLI wins over both env and file
    expect(config.transport).toBe('stdio');
    expect(config.responseMode).toBe('structured');
  });
});

// ---------------------------------------------------------------------------
// loadConfig — precedence merging
// ---------------------------------------------------------------------------

describe('loadConfig — precedence: CLI > env > file', () => {
  it('CLI overrides env which overrides file', () => {
    const filePath = writeJsonFile('config.json', {
      agents: MINIMAL_AGENTS,
      syncBudgetMs: 1000,
      taskRetentionMs: 2000,
      responseMode: 'raw',
    });

    const config = loadConfig({
      filePath,
      env: {
        A2A_MCP_SYNC_BUDGET_MS: '3000',
        A2A_MCP_RESPONSE_MODE: 'compact',
      },
      cli: { syncBudgetMs: 5000 },
    });

    // CLI wins for syncBudgetMs
    expect(config.syncBudgetMs).toBe(5000);
    // Env wins for responseMode (no CLI override)
    expect(config.responseMode).toBe('compact');
    // File wins for taskRetentionMs (no env or CLI override)
    expect(config.taskRetentionMs).toBe(2000);
  });

  it('env overrides file when CLI is absent', () => {
    const filePath = writeJsonFile('config.json', {
      agents: MINIMAL_AGENTS,
      logging: { level: 'error' },
    });

    const config = loadConfig({
      filePath,
      env: { A2A_MCP_LOG_LEVEL: 'debug' },
    });

    expect(config.logging.level).toBe('debug');
  });

  it('file values are used when env and CLI are absent', () => {
    const filePath = writeJsonFile('config.json', {
      agents: MINIMAL_AGENTS,
      syncBudgetMs: 42000,
    });

    const config = loadConfig({ filePath });
    expect(config.syncBudgetMs).toBe(42000);
  });

  it('nested http fields merge correctly across sources', () => {
    const filePath = writeJsonFile('config.json', {
      agents: MINIMAL_AGENTS,
      http: { port: 3000, inboundAuth: { mode: 'none' } },
    });

    const config = loadConfig({
      filePath,
      env: { A2A_MCP_PORT: '8080' },
      cli: { http: { inboundAuth: { mode: 'bearer', token: 'tok' } } },
    });

    // Env overrides file port
    expect(config.http?.port).toBe(8080);
    // CLI overrides inbound auth
    expect(config.http?.inboundAuth.mode).toBe('bearer');
    expect(config.http?.inboundAuth.token).toBe('tok');
  });
});

// ---------------------------------------------------------------------------
// loadConfig — no sources (defaults only)
// ---------------------------------------------------------------------------

describe('loadConfig — no sources', () => {
  it('fails validation when no agents are provided', () => {
    expect(() => loadConfig()).toThrow(ConfigLoadError);
  });

  it('succeeds with CLI agents only', () => {
    const config = loadConfig({ cli: { agents: MINIMAL_AGENTS } });
    expect(config.agents).toHaveLength(1);
    expect(config.transport).toBe('stdio');
  });
});

// ---------------------------------------------------------------------------
// redactConfig
// ---------------------------------------------------------------------------

describe('redactConfig', () => {
  it('redacts agent auth tokens', () => {
    const config: BridgeConfig = {
      agents: [
        { url: 'https://a.com', auth: { mode: 'bearer', token: 'super-secret' } },
      ],
      transport: 'stdio',
      responseMode: 'structured',
      syncBudgetMs: 30000,
      taskRetentionMs: 3600000,
      retry: { maxAttempts: 3, initialDelayMs: 500 },
      logging: { level: 'info' },
    };

    const redacted = redactConfig(config);
    const agents = redacted['agents'] as Array<Record<string, unknown>>;
    const auth = agents[0]['auth'] as Record<string, unknown>;

    expect(auth['token']).toBe('[REDACTED]');
    // Original is not mutated
    expect(config.agents[0].auth.token).toBe('super-secret');
  });

  it('redacts inbound auth token', () => {
    const config: BridgeConfig = {
      agents: [{ url: 'https://a.com', auth: { mode: 'none' } }],
      transport: 'http',
      http: {
        port: 3000,
        inboundAuth: { mode: 'bearer', token: 'inbound-secret' },
      },
      responseMode: 'structured',
      syncBudgetMs: 30000,
      taskRetentionMs: 3600000,
      retry: { maxAttempts: 3, initialDelayMs: 500 },
      logging: { level: 'info' },
    };

    const redacted = redactConfig(config);
    const http = redacted['http'] as Record<string, unknown>;
    const inboundAuth = http['inboundAuth'] as Record<string, unknown>;

    expect(inboundAuth['token']).toBe('[REDACTED]');
    // Original is not mutated
    expect(config.http!.inboundAuth.token).toBe('inbound-secret');
  });

  it('handles config without tokens gracefully', () => {
    const config: BridgeConfig = {
      agents: [{ url: 'https://a.com', auth: { mode: 'none' } }],
      transport: 'stdio',
      responseMode: 'structured',
      syncBudgetMs: 30000,
      taskRetentionMs: 3600000,
      retry: { maxAttempts: 3, initialDelayMs: 500 },
      logging: { level: 'info' },
    };

    const redacted = redactConfig(config);
    const agents = redacted['agents'] as Array<Record<string, unknown>>;
    const auth = agents[0]['auth'] as Record<string, unknown>;

    expect(auth['mode']).toBe('none');
    expect(auth['token']).toBeUndefined();
  });
});
