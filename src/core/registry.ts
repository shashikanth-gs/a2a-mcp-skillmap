/**
 * AgentRegistry — manages the set of configured agents, drives card resolution
 * with retry + backoff, and caches resolved results in a `RegistryStore`.
 *
 * @module core/registry
 */

import type {
  AgentAuthProvider,
  AgentConfig,
  RegistryStore,
  ResolvedAgent,
} from '../types/index.js';
import { AgentResolver } from '../a2a/agent-resolver.js';
import { MemoryRegistryStore } from '../storage/memory-registry-store.js';

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  factor?: number; // default 2
  jitterRatio?: number; // ±ratio of each delay, default 0.1
}

const DEFAULT_RETRY: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelayMs: 500,
  factor: 2,
  jitterRatio: 0.1,
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface AgentRegistryOptions {
  resolver?: AgentResolver;
  store?: RegistryStore;
  retry?: RetryConfig;
  /** Inject a scheduler for deterministic tests. */
  scheduler?: {
    sleep(ms: number): Promise<void>;
  };
  /** Per-agent auth provider lookup, keyed by URL. */
  authProviders?: Map<string, AgentAuthProvider>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgentRegistryError extends Error {
  public readonly code: 'AGENT_FETCH_FAILED' | 'AGENT_UNKNOWN';
  public readonly agentUrl: string;
  public readonly cause?: unknown;

  constructor(
    message: string,
    code: AgentRegistryError['code'],
    agentUrl: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'AgentRegistryError';
    this.code = code;
    this.agentUrl = agentUrl;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export class AgentRegistry {
  private readonly configs = new Map<string, AgentConfig>();
  private readonly resolver: AgentResolver;
  private readonly store: RegistryStore;
  private readonly retry: Required<RetryConfig>;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly authProviders: Map<string, AgentAuthProvider>;

  constructor(options: AgentRegistryOptions = {}) {
    this.resolver = options.resolver ?? new AgentResolver();
    this.store = options.store ?? new MemoryRegistryStore();
    this.retry = { ...DEFAULT_RETRY, ...(options.retry ?? {}) };
    this.sleep =
      options.scheduler?.sleep ??
      ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    this.authProviders = options.authProviders ?? new Map();
  }

  /** Register an agent URL for later resolution. */
  registerAgent(config: AgentConfig): void {
    this.configs.set(config.url, config);
  }

  /** Resolve all registered agents; return only successfully resolved ones. */
  async resolveAll(): Promise<ResolvedAgent[]> {
    const urls = Array.from(this.configs.keys());
    const results: ResolvedAgent[] = [];
    for (const url of urls) {
      const resolved = await this.resolveWithRetry(url);
      this.store.put(url, resolved);
      results.push(resolved);
    }
    return results;
  }

  /** Atomically refresh one agent; on failure, retain prior cached entry. */
  async refreshAgent(agentUrl: string): Promise<ResolvedAgent> {
    if (!this.configs.has(agentUrl)) {
      throw new AgentRegistryError(
        `Agent ${agentUrl} is not registered`,
        'AGENT_UNKNOWN',
        agentUrl,
      );
    }
    const refreshed = await this.resolveWithRetry(agentUrl);
    this.store.put(agentUrl, refreshed);
    return refreshed;
  }

  getAgent(agentUrl: string): ResolvedAgent | undefined {
    return this.store.get(agentUrl);
  }

  getAllAgents(): ResolvedAgent[] {
    return this.store.list();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async resolveWithRetry(agentUrl: string): Promise<ResolvedAgent> {
    const auth = this.authProviders.get(agentUrl);
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
      try {
        return await this.resolver.resolve(agentUrl, auth);
      } catch (err) {
        lastErr = err;
        if (attempt === this.retry.maxAttempts) break;
        const base =
          this.retry.initialDelayMs * this.retry.factor ** (attempt - 1);
        const jitter = base * this.retry.jitterRatio * (Math.random() * 2 - 1);
        const delay = Math.max(0, Math.round(base + jitter));
        await this.sleep(delay);
      }
    }
    throw new AgentRegistryError(
      `Agent card fetch failed after ${this.retry.maxAttempts} attempts for ${agentUrl}`,
      'AGENT_FETCH_FAILED',
      agentUrl,
      lastErr,
    );
  }
}
