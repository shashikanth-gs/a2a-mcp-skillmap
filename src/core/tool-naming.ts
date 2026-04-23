/**
 * ToolNamingStrategy — derive deterministic MCP tool names from
 * (agentId, skillId) pairs. Pluggable interface with a default implementation.
 *
 * Default rules:
 *   - Sanitize: replace any character outside `[a-zA-Z0-9_-]` with `_`.
 *   - Join: `{sanitize(agentId)}__{sanitize(skillId)}`.
 *   - Truncate to `MAX_MCP_TOOL_NAME_LENGTH` while leaving room for a hash suffix.
 *   - If sanitization produced an empty segment, substitute a hash of the raw value.
 *   - On explicit collision, a caller can invoke `withCollisionSalt()` which
 *     prefixes a deterministic hash-based namespace token.
 *
 * All functions are pure — same input ⇒ same output across runs.
 *
 * @module core/tool-naming
 */

import { createHash } from 'node:crypto';
import type { ToolNamingStrategy } from '../types/index.js';

/** MCP tool-name max length (conservative, matches SDK-enforced limit of 64). */
export const MAX_MCP_TOOL_NAME_LENGTH = 64;

/** Character class allowed in MCP tool names. */
const ALLOWED_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/** Anything outside the allowed set is replaced with `_`. */
function sanitize(segment: string): string {
  if (segment.length === 0) return '';
  return segment.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Short deterministic hash used as a disambiguator (first 8 hex chars). */
function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

/**
 * Produce a name segment that is guaranteed to be non-empty and to match the
 * allowed regex. If sanitization stripped the input down to nothing, fall back
 * to a hash of the original.
 */
function safeSegment(raw: string): string {
  const clean = sanitize(raw);
  if (clean.length === 0) return `h${shortHash(raw)}`;
  return clean;
}

/**
 * Truncate a name while preserving determinism: if truncation occurs, append a
 * short hash of the full name to preserve uniqueness.
 */
function truncateWithHash(name: string, maxLen: number): string {
  if (name.length <= maxLen) return name;
  const hash = shortHash(name);
  // Reserve the hash + separator (`-`) at the end.
  const keep = maxLen - hash.length - 1;
  if (keep <= 0) return hash.slice(0, maxLen);
  return `${name.slice(0, keep)}-${hash}`;
}

// ---------------------------------------------------------------------------
// Default strategy
// ---------------------------------------------------------------------------

export class DefaultToolNamingStrategy implements ToolNamingStrategy {
  constructor(
    public readonly maxLength: number = MAX_MCP_TOOL_NAME_LENGTH,
  ) {}

  deriveName(agentId: string, skillId: string): string {
    const agent = safeSegment(String(agentId ?? ''));
    const skill = safeSegment(String(skillId ?? ''));
    const raw = `${agent}__${skill}`;
    return truncateWithHash(raw, this.maxLength);
  }

  /**
   * Produce a collision-resistant name by prefixing a hash of the source URL.
   * Used by `ToolGenerator` when two distinct agents share an agentId+skillId
   * post-sanitization.
   */
  deriveNameWithNamespace(
    agentUrl: string,
    agentId: string,
    skillId: string,
  ): string {
    const ns = `ns${shortHash(agentUrl)}`;
    const agent = safeSegment(String(agentId ?? ''));
    const skill = safeSegment(String(skillId ?? ''));
    const raw = `${ns}__${agent}__${skill}`;
    return truncateWithHash(raw, this.maxLength);
  }

  isValid(name: string): boolean {
    if (typeof name !== 'string') return false;
    if (name.length === 0 || name.length > this.maxLength) return false;
    return ALLOWED_NAME_REGEX.test(name);
  }
}
