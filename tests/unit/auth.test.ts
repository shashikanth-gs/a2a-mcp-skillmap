import { describe, it, expect } from 'vitest';
import {
  BearerInboundAuth,
  ApiKeyInboundAuth,
  NoopInboundAuth,
  createInboundAuth,
  InboundAuthMisconfiguredError,
} from '../../src/auth/inbound/index.js';
import {
  BearerAgentAuth,
  ApiKeyAgentAuth,
  NoopAgentAuth,
  createAgentAuth,
  OutboundAuthMisconfiguredError,
} from '../../src/auth/outbound/index.js';

// ---------------------------------------------------------------------------
// Inbound
// ---------------------------------------------------------------------------

describe('Inbound auth providers', () => {
  it('NoopInboundAuth accepts all requests', async () => {
    const auth = new NoopInboundAuth();
    expect(await auth.authenticate({ headers: {} })).toBe(true);
  });

  it('BearerInboundAuth accepts correct token, rejects wrong', async () => {
    const auth = new BearerInboundAuth({ token: 'secret' });
    expect(
      await auth.authenticate({
        headers: { authorization: 'Bearer secret' },
      }),
    ).toBe(true);
    expect(
      await auth.authenticate({
        headers: { authorization: 'Bearer wrong' },
      }),
    ).toBe(false);
    expect(await auth.authenticate({ headers: {} })).toBe(false);
  });

  it('ApiKeyInboundAuth checks the configured header', async () => {
    const auth = new ApiKeyInboundAuth({
      token: 'k',
      headerName: 'X-My-Key',
    });
    expect(
      await auth.authenticate({ headers: { 'x-my-key': 'k' } }),
    ).toBe(true);
    expect(
      await auth.authenticate({ headers: { 'x-my-key': 'w' } }),
    ).toBe(false);
  });

  it('createInboundAuth rejects misconfigured modes', () => {
    expect(() =>
      createInboundAuth({ mode: 'bearer' } as never),
    ).toThrow(InboundAuthMisconfiguredError);
    expect(() =>
      createInboundAuth({ mode: 'api_key' } as never),
    ).toThrow(InboundAuthMisconfiguredError);
  });
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

describe('Outbound auth providers', () => {
  it('NoopAgentAuth does not mutate headers', () => {
    const headers: Record<string, string> = {};
    new NoopAgentAuth().applyAuth(headers);
    expect(headers).toEqual({});
  });

  it('BearerAgentAuth attaches Authorization header', () => {
    const auth = new BearerAgentAuth('tok');
    const h: Record<string, string> = {};
    auth.applyAuth(h);
    expect(h['Authorization']).toBe('Bearer tok');
  });

  it('ApiKeyAgentAuth attaches configured header', () => {
    const auth = new ApiKeyAgentAuth('tok', 'X-Custom');
    const h: Record<string, string> = {};
    auth.applyAuth(h);
    expect(h['X-Custom']).toBe('tok');
  });

  it('createAgentAuth rejects mode=bearer without token', () => {
    expect(() =>
      createAgentAuth({ mode: 'bearer' } as never, 'https://a.com'),
    ).toThrow(OutboundAuthMisconfiguredError);
  });

  it('createAgentAuth rejects mode=api_key without token', () => {
    expect(() =>
      createAgentAuth({ mode: 'api_key' } as never, 'https://a.com'),
    ).toThrow(OutboundAuthMisconfiguredError);
  });

  it('createAgentAuth returns each auth type for valid configs', () => {
    expect(
      createAgentAuth({ mode: 'none' }, 'https://a.com').redactedDescription(),
    ).toBe('none');
    expect(
      createAgentAuth(
        { mode: 'bearer', token: 't' },
        'https://a.com',
      ).redactedDescription(),
    ).toContain('bearer');
    expect(
      createAgentAuth(
        { mode: 'api_key', token: 't', headerName: 'X-K' },
        'https://a.com',
      ).redactedDescription(),
    ).toContain('api_key');
  });

  it('createInboundAuth returns each auth type for valid configs', () => {
    expect(createInboundAuth({ mode: 'none' })).toBeInstanceOf(
      NoopInboundAuth,
    );
    expect(
      createInboundAuth({ mode: 'bearer', token: 't' }),
    ).toBeInstanceOf(BearerInboundAuth);
    expect(
      createInboundAuth({
        mode: 'api_key',
        token: 't',
        headerName: 'X-K',
      }),
    ).toBeInstanceOf(ApiKeyInboundAuth);
  });

  it('BearerInboundAuth rejects malformed Authorization header', async () => {
    const auth = new BearerInboundAuth({ token: 'tok' });
    expect(
      await auth.authenticate({
        headers: { authorization: 'NotBearer tok' },
      }),
    ).toBe(false);
  });

  it('ApiKeyInboundAuth handles array-valued headers', async () => {
    const auth = new ApiKeyInboundAuth({
      token: 'tok',
      headerName: 'X-K',
    });
    expect(
      await auth.authenticate({ headers: { 'x-k': ['tok', 'other'] } }),
    ).toBe(true);
  });
});
