/**
 * Resolve an agent-card URL from whatever the operator supplied:
 *
 *   - If the input already points at an explicit card file
 *     (`*.json` / `*.yaml` / `*.yml`), use it as-is.
 *   - Otherwise treat it as a base URL and probe, in order:
 *       1. `{base}/.well-known/agent-card.json` (current A2A spec)
 *       2. `{base}/.well-known/agent.json`      (older A2A deployments)
 *     Return the first path that responds with 2xx.
 *
 * The helper fetches the body on success and returns it to the caller so
 * the card can be parsed once (no double-fetch).
 *
 * @module a2a/card-url
 */

const EXPLICIT_CARD_RE = /\.(json|yaml|yml)$/i;
const CANDIDATE_PATHS = ['.well-known/agent-card.json', '.well-known/agent.json'] as const;

export interface ResolvedCard {
  /** The URL that actually served the card. */
  cardUrl: string;
  /** The raw response body (decoded as text). */
  cardText: string;
}

export class CardUrlResolutionError extends Error {
  public readonly code = 'AGENT_FETCH_FAILED';
  public readonly input: string;
  public readonly attempts: Array<{ url: string; status?: number; error?: string }>;

  constructor(
    input: string,
    attempts: Array<{ url: string; status?: number; error?: string }>,
  ) {
    const summary = attempts
      .map((a) =>
        a.status !== undefined ? `${a.url} → ${a.status}` : `${a.url} → ${a.error}`,
      )
      .join('; ');
    super(`Could not fetch agent card from ${input}: ${summary}`);
    this.name = 'CardUrlResolutionError';
    this.input = input;
    this.attempts = attempts;
  }
}

/** Append a path to a URL, collapsing any duplicate slashes at the join. */
function joinPath(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const tail = path.startsWith('/') ? path.slice(1) : path;
  return `${base}/${tail}`;
}

/**
 * Resolve a card URL. `fetchImpl` is injectable for tests and auth-wrapping.
 */
export async function resolveCardUrl(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedCard> {
  const candidates = EXPLICIT_CARD_RE.test(input)
    ? [input]
    : CANDIDATE_PATHS.map((p) => joinPath(input, p));

  const attempts: Array<{ url: string; status?: number; error?: string }> = [];

  for (const url of candidates) {
    try {
      const response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
      });
      if (response.ok) {
        return { cardUrl: url, cardText: await response.text() };
      }
      attempts.push({ url, status: response.status });
    } catch (err) {
      attempts.push({
        url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  throw new CardUrlResolutionError(input, attempts);
}
