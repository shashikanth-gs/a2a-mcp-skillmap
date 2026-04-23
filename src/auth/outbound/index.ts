/**
 * Outbound auth providers for A2A agent requests.
 *
 * All implementations expose a `redactedDescription()` that replaces the
 * credential value with `[REDACTED]` for safe logging.
 *
 * @module auth/outbound
 */

import type { AgentAuthProvider } from '../../types/index.js';

const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// None
// ---------------------------------------------------------------------------

export class NoopAgentAuth implements AgentAuthProvider {
  applyAuth(_headers: Record<string, string>): void {
    // no-op
  }
  redactedDescription(): string {
    return 'none';
  }
}

// ---------------------------------------------------------------------------
// Bearer
// ---------------------------------------------------------------------------

export class BearerAgentAuth implements AgentAuthProvider {
  constructor(private readonly token: string) {
    if (!token) throw new Error('BearerAgentAuth: token is required');
  }
  applyAuth(headers: Record<string, string>): void {
    headers['Authorization'] = `Bearer ${this.token}`;
  }
  redactedDescription(): string {
    return `bearer ${REDACTED}`;
  }
}

// ---------------------------------------------------------------------------
// API Key
// ---------------------------------------------------------------------------

export class ApiKeyAgentAuth implements AgentAuthProvider {
  constructor(
    private readonly token: string,
    private readonly headerName: string = 'X-API-Key',
  ) {
    if (!token) throw new Error('ApiKeyAgentAuth: token is required');
  }
  applyAuth(headers: Record<string, string>): void {
    headers[this.headerName] = this.token;
  }
  redactedDescription(): string {
    return `api_key(${this.headerName}) ${REDACTED}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface AgentAuthConfig {
  mode: 'none' | 'bearer' | 'api_key';
  token?: string;
  headerName?: string;
}

export class OutboundAuthMisconfiguredError extends Error {
  public readonly code = 'AUTH_MISCONFIGURED';
  public readonly agentUrl: string;

  constructor(message: string, agentUrl: string) {
    super(message);
    this.name = 'OutboundAuthMisconfiguredError';
    this.agentUrl = agentUrl;
  }
}

export function createAgentAuth(
  config: AgentAuthConfig,
  agentUrl: string,
): AgentAuthProvider {
  switch (config.mode) {
    case 'none':
      return new NoopAgentAuth();
    case 'bearer':
      if (!config.token) {
        throw new OutboundAuthMisconfiguredError(
          `agent ${agentUrl}: auth mode=bearer requires token`,
          agentUrl,
        );
      }
      return new BearerAgentAuth(config.token);
    case 'api_key':
      if (!config.token) {
        throw new OutboundAuthMisconfiguredError(
          `agent ${agentUrl}: auth mode=api_key requires token`,
          agentUrl,
        );
      }
      return new ApiKeyAgentAuth(config.token, config.headerName);
    /* c8 ignore next 2 -- exhaustive */
    default:
      throw new OutboundAuthMisconfiguredError(
        `agent ${agentUrl}: unknown auth mode ${String((config as { mode: string }).mode)}`,
        agentUrl,
      );
  }
}
