/**
 * ToolGenerator — convert `ResolvedAgent[]` into `ToolDeclaration[]`.
 *
 * Each `ResolvedSkill` becomes exactly one `ToolDeclaration`. On name
 * collisions, the generator falls back to a namespaced name via
 * `DefaultToolNamingStrategy.deriveNameWithNamespace()`.
 *
 * @module core/tool-generator
 */

import type {
  ResolvedAgent,
  ResolvedSkill,
  ToolDeclaration,
  ToolNamingStrategy,
  ToolSource,
} from '../types/index.js';
import { buildInputSchema } from '../a2a/skill-normalizer.js';
import { DefaultToolNamingStrategy } from './tool-naming.js';

export interface ToolGeneratorOptions {
  namingStrategy?: ToolNamingStrategy;
}

export class ToolGenerator {
  private readonly naming: ToolNamingStrategy;
  private readonly sourceByName = new Map<string, ToolSource>();

  constructor(options: ToolGeneratorOptions = {}) {
    this.naming = options.namingStrategy ?? new DefaultToolNamingStrategy();
  }

  /** Generate tool declarations, resetting any prior state. */
  generateTools(agents: ResolvedAgent[]): ToolDeclaration[] {
    this.sourceByName.clear();
    const declarations: ToolDeclaration[] = [];

    for (const agent of agents) {
      for (const skill of agent.skills) {
        const decl = this.generateOne(agent, skill);
        declarations.push(decl);
        this.sourceByName.set(decl.name, decl.metadata);
      }
    }
    return declarations;
  }

  /** Look up the source of a tool by its generated name. */
  resolveToolSource(toolName: string): ToolSource | undefined {
    return this.sourceByName.get(toolName);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private generateOne(
    agent: ResolvedAgent,
    skill: ResolvedSkill,
  ): ToolDeclaration {
    const primary = this.naming.deriveName(agent.id, skill.id);
    const name = this.sourceByName.has(primary)
      ? this.deriveNamespacedName(agent, skill)
      : primary;

    const source: ToolSource = {
      agentUrl: agent.url,
      agentId: agent.id,
      skillId: skill.id,
    };

    return {
      name,
      description: skill.description || skill.name,
      inputSchema: buildInputSchema(skill),
      metadata: source,
    };
  }

  private deriveNamespacedName(
    agent: ResolvedAgent,
    skill: ResolvedSkill,
  ): string {
    // Default strategy exposes a namespaced method; custom strategies can
    // override `deriveName` to include namespacing themselves.
    if (this.naming instanceof DefaultToolNamingStrategy) {
      return this.naming.deriveNameWithNamespace(agent.url, agent.id, skill.id);
    }
    // Fallback: prepend agentUrl hash via the plain naming function.
    return this.naming.deriveName(`${agent.url}_${agent.id}`, skill.id);
  }
}
