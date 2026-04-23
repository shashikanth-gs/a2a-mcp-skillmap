/**
 * Inbound auth providers for the HTTP transport.
 *
 * None of these implementations echo credential values. On rejection the
 * caller-facing response is a structured 401 body without the submitted token.
 *
 * @module auth/inbound
 */

import type {
  InboundAuthProvider,
  IncomingRequest,
} from '../../types/index.js';

const REDACTED = '[REDACTED]';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function headerValue(
  req: IncomingRequest,
  name: string,
): string | undefined {
  const key = Object.keys(req.headers).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  if (!key) return undefined;
  const v = req.headers[key];
  if (Array.isArray(v)) return v[0];
  return v;
}

// ---------------------------------------------------------------------------
// None
// ---------------------------------------------------------------------------

export class NoopInboundAuth implements InboundAuthProvider {
  readonly mode = 'none' as const;

  async authenticate(_req: IncomingRequest): Promise<boolean> {
    return true;
  }
}

// ---------------------------------------------------------------------------
// Bearer
// ---------------------------------------------------------------------------

export interface BearerInboundAuthConfig {
  token: string;
}

export class BearerInboundAuth implements InboundAuthProvider {
  readonly mode = 'bearer' as const;
  private readonly expected: string;

  constructor(config: BearerInboundAuthConfig) {
    if (!config.token) {
      throw new Error('BearerInboundAuth: token is required');
    }
    this.expected = config.token;
  }

  async authenticate(req: IncomingRequest): Promise<boolean> {
    const header = headerValue(req, 'authorization');
    if (!header) return false;
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) return false;
    return safeEqual(match[1]!, this.expected);
  }

  describe(): string {
    return `bearer ${REDACTED}`;
  }
}

// ---------------------------------------------------------------------------
// API Key
// ---------------------------------------------------------------------------

export interface ApiKeyInboundAuthConfig {
  token: string;
  headerName?: string;
}

export class ApiKeyInboundAuth implements InboundAuthProvider {
  readonly mode = 'api_key' as const;
  private readonly expected: string;
  private readonly headerName: string;

  constructor(config: ApiKeyInboundAuthConfig) {
    if (!config.token) {
      throw new Error('ApiKeyInboundAuth: token is required');
    }
    this.expected = config.token;
    this.headerName = config.headerName ?? 'X-API-Key';
  }

  async authenticate(req: IncomingRequest): Promise<boolean> {
    const header = headerValue(req, this.headerName);
    if (!header) return false;
    return safeEqual(header, this.expected);
  }

  describe(): string {
    return `api_key(${this.headerName}) ${REDACTED}`;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface InboundAuthConfig {
  mode: 'none' | 'bearer' | 'api_key';
  token?: string;
  headerName?: string;
}

export class InboundAuthMisconfiguredError extends Error {
  public readonly code = 'AUTH_MISCONFIGURED';
  constructor(message: string) {
    super(message);
    this.name = 'InboundAuthMisconfiguredError';
  }
}

export function createInboundAuth(
  config: InboundAuthConfig,
): InboundAuthProvider {
  switch (config.mode) {
    case 'none':
      return new NoopInboundAuth();
    case 'bearer':
      if (!config.token) {
        throw new InboundAuthMisconfiguredError(
          'inbound auth mode=bearer requires token',
        );
      }
      return new BearerInboundAuth({ token: config.token });
    case 'api_key':
      if (!config.token) {
        throw new InboundAuthMisconfiguredError(
          'inbound auth mode=api_key requires token',
        );
      }
      return new ApiKeyInboundAuth({
        token: config.token,
        ...(config.headerName !== undefined
          ? { headerName: config.headerName }
          : {}),
      });
    /* c8 ignore next 2 -- exhaustive */
    default:
      throw new InboundAuthMisconfiguredError(
        `Unknown inbound auth mode: ${String((config as { mode: string }).mode)}`,
      );
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Constant-time string comparison to avoid timing oracles. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
