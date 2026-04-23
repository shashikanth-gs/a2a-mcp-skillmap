/**
 * In-memory `Map`-backed implementation of `RegistryStore`.
 *
 * @module storage/memory-registry-store
 */

import type { RegistryStore, ResolvedAgent } from '../types/index.js';

export class MemoryRegistryStore implements RegistryStore {
  private readonly store = new Map<string, ResolvedAgent>();

  put(agentUrl: string, agent: ResolvedAgent): void {
    this.store.set(agentUrl, agent);
  }

  get(agentUrl: string): ResolvedAgent | undefined {
    return this.store.get(agentUrl);
  }

  list(): ResolvedAgent[] {
    return Array.from(this.store.values());
  }

  delete(agentUrl: string): void {
    this.store.delete(agentUrl);
  }
}
