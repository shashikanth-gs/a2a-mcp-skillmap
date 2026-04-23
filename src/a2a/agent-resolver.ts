/**
 * AgentResolver — fetch an A2A agent card, validate its shape, and normalize
 * its skills into the canonical model.
 *
 * URL handling (see `./card-url.ts`):
 *   - If the caller passes an explicit card URL (`*.json`/`*.yaml`/`*.yml`),
 *     we use it as-is.
 *   - Otherwise we probe `.well-known/agent-card.json` first, then
 *     `.well-known/agent.json`, and use whichever responds with 2xx.
 *
 * The resolver is transport-agnostic: it depends on an injectable "card fetcher"
 * function. Tests inject a stub fetcher.
 *
 * @module a2a/agent-resolver
 */

import { z } from 'zod';
import type { AgentAuthProvider, ResolvedAgent } from '../types/index.js';
import {
  normalizeSkills,
  type A2AAgentMeta,
  type A2AInputSkill,
} from './skill-normalizer.js';
import { resolveCardUrl } from './card-url.js';

// ---------------------------------------------------------------------------
// Zod schema for agent card validation (subset we actually consume)
// ---------------------------------------------------------------------------

/** Validates the minimum shape our bridge requires. */
export const AgentCardShapeSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  version: z.string().min(1),
  url: z.string().min(1),
  protocolVersion: z.string().optional(),
  defaultInputModes: z.array(z.string()).default([]),
  defaultOutputModes: z.array(z.string()).default([]),
  skills: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().optional(),
      tags: z.array(z.string()).default([]),
      inputModes: z.array(z.string()).optional(),
      outputModes: z.array(z.string()).optional(),
      inputSchema: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
});

export type AgentCardShape = z.infer<typeof AgentCardShapeSchema>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgentResolutionError extends Error {
  public readonly code:
    | 'AGENT_FETCH_FAILED'
    | 'AGENT_CARD_INVALID'
    | 'AGENT_CARD_EMPTY';
  public readonly agentUrl: string;
  public readonly cause?: unknown;

  constructor(
    message: string,
    code: AgentResolutionError['code'],
    agentUrl: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentResolutionError';
    this.code = code;
    this.agentUrl = agentUrl;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/**
 * Function that fetches a card given the operator-supplied URL.
 *
 * Returns either:
 *   - `{ cardUrl, raw }` — the structured form, explicit about where the card
 *     was actually fetched from; or
 *   - the raw card object alone (back-compat shorthand — `cardUrl` is then
 *     assumed to equal `inputUrl`).
 */
export type AgentCardFetcher = (
  inputUrl: string,
  auth?: AgentAuthProvider,
) => Promise<{ cardUrl: string; raw: unknown } | unknown>;

export interface AgentResolverOptions {
  /** Custom fetcher; default probes well-known paths via `fetch`. */
  fetcher?: AgentCardFetcher;
}

export class AgentResolver {
  private readonly fetcher: AgentCardFetcher;

  constructor(options: AgentResolverOptions = {}) {
    this.fetcher = options.fetcher ?? defaultAgentCardFetcher;
  }

  /** Fetch + validate + normalize. Returns a `ResolvedAgent`. */
  async resolve(
    agentUrl: string,
    auth?: AgentAuthProvider,
  ): Promise<ResolvedAgent> {
    let fetched: { cardUrl: string; raw: unknown };
    try {
      const returned = await this.fetcher(agentUrl, auth);
      fetched = normalizeFetcherReturn(returned, agentUrl);
    } catch (err) {
      throw new AgentResolutionError(
        `Failed to fetch agent card from ${agentUrl}: ${String(err instanceof Error ? err.message : err)}`,
        'AGENT_FETCH_FAILED',
        agentUrl,
        err,
      );
    }

    if (fetched.raw === null || fetched.raw === undefined) {
      throw new AgentResolutionError(
        `Agent card at ${fetched.cardUrl} was empty`,
        'AGENT_CARD_EMPTY',
        agentUrl,
      );
    }

    const parsed = AgentCardShapeSchema.safeParse(fetched.raw);
    if (!parsed.success) {
      throw new AgentResolutionError(
        `Agent card at ${fetched.cardUrl} failed schema validation: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
        'AGENT_CARD_INVALID',
        agentUrl,
        parsed.error,
      );
    }
    const card = parsed.data;

    const agentMeta: A2AAgentMeta = {
      agentUrl,
      agentId: deriveAgentId(card, agentUrl),
      defaultInputModes: card.defaultInputModes,
      defaultOutputModes: card.defaultOutputModes,
    };

    const { accepted } = normalizeSkills(card.skills as A2AInputSkill[], agentMeta);

    return {
      url: agentUrl,
      cardUrl: fetched.cardUrl,
      id: agentMeta.agentId,
      name: card.name,
      version: card.version,
      description: card.description,
      skills: accepted,
      rawCard: fetched.raw,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Accept either the structured `{ cardUrl, raw }` form or the raw card alone,
 * and always produce the structured form for downstream consumers.
 *
 * Disambiguation: a real A2A card has `name` + `skills`. The structured
 * wrapper has exactly `cardUrl` + `raw`. We require the wrapper to not
 * carry card-identifying fields so a card that happens to include a
 * `cardUrl` property would still be parsed as a card.
 */
function normalizeFetcherReturn(
  returned: unknown,
  agentUrl: string,
): { cardUrl: string; raw: unknown } {
  if (
    returned !== null &&
    typeof returned === 'object' &&
    'cardUrl' in returned &&
    'raw' in returned &&
    !('name' in returned) &&
    !('skills' in returned)
  ) {
    const r = returned as { cardUrl: unknown; raw: unknown };
    if (typeof r.cardUrl === 'string') {
      return { cardUrl: r.cardUrl, raw: r.raw };
    }
  }
  return { cardUrl: agentUrl, raw: returned };
}

/**
 * Derive a stable agent ID from the card. A2A cards do not have an explicit
 * `id` field, so we use the `name` for human-readability, stripping whitespace.
 * Callers can override via a custom resolver if they need deterministic IDs.
 */
function deriveAgentId(card: AgentCardShape, agentUrl: string): string {
  const raw = card.name ?? agentUrl;
  return raw.trim().length > 0 ? raw.trim() : agentUrl;
}

/**
 * Default fetcher: probe well-known paths via our `resolveCardUrl` helper,
 * optionally wiring outbound auth headers via a custom fetchImpl.
 */
async function defaultAgentCardFetcher(
  agentUrl: string,
  auth?: AgentAuthProvider,
): Promise<{ cardUrl: string; raw: unknown }> {
  const fetchImpl: typeof fetch = auth
    ? (async (input, init) => {
        const headers = new Headers(init?.headers ?? {});
        const bag: Record<string, string> = {};
        auth.applyAuth(bag);
        for (const [k, v] of Object.entries(bag)) headers.set(k, v);
        return fetch(input, { ...init, headers });
      }) as typeof fetch
    : fetch;

  const { cardUrl, cardText } = await resolveCardUrl(agentUrl, fetchImpl);
  return { cardUrl, raw: JSON.parse(cardText) as unknown };
}
