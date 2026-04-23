/**
 * ResponseProjector — shape a `CanonicalResult` into an MCP `CallToolResult`
 * according to the configured `ResponseMode`.
 *
 * Modes:
 *   - `artifact` (default): unwraps A2A `parts[]` across every artifact and
 *     emits typed MCP content blocks — `text` for text parts, `image` or
 *     `audio` for inline-base64 file parts whose MIME fits, `resource` for
 *     URI-based file parts, `text` placeholders for non-media inline files,
 *     and stringified JSON for data parts. Multimodal-aware; preserves every
 *     part, nothing silently dropped.
 *   - `structured`: full canonical result in `structuredContent` + short
 *     human-readable text fallback in `content`. Best for MCP clients that
 *     also want metadata (correlation IDs, durations, task ids).
 *   - `compact`:    a summary string of at most 280 chars as the sole text
 *                   block. Best for bandwidth-constrained or token-sensitive
 *                   paths.
 *   - `raw`:        dumps every artifact's raw A2A `data` field verbatim. The
 *                   full message/task object (kind, role, parts, taskId,
 *                   contextId, …) is preserved in both `content` text and
 *                   `structuredContent`. Best for debugging and downstream
 *                   analytics that need the original payload.
 *
 * The projector is deterministic: identical inputs produce byte-equivalent
 * outputs across invocations (Property 10).
 *
 * @module core/response-projector
 */

import type {
  CallToolResult,
  ContentBlock,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  CanonicalResult,
  ProjectionContext,
  ResponseProjector,
} from '../types/index.js';

const COMPACT_SUMMARY_LIMIT = 280;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultResponseProjector implements ResponseProjector {
  project(result: CanonicalResult, context: ProjectionContext): CallToolResult {
    switch (context.mode) {
      case 'structured':
        return this.projectStructured(result, context);
      case 'compact':
        return this.projectCompact(result, context);
      case 'artifact':
        return this.projectArtifact(result, context);
      case 'raw':
        return this.projectRaw(result, context);
      /* c8 ignore next 2 -- type narrowing guards the switch */
      default:
        throw new Error(`Unknown response mode: ${String(context.mode)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Mode implementations
  // -------------------------------------------------------------------------

  private projectStructured(
    result: CanonicalResult,
    _context: ProjectionContext,
  ): CallToolResult {
    const text = buildTextFallback(result);
    return {
      content: [{ type: 'text', text }],
      structuredContent: serializeStructured(result),
    };
  }

  private projectCompact(
    result: CanonicalResult,
    _context: ProjectionContext,
  ): CallToolResult {
    const summary = buildCompactSummary(result);
    return {
      content: [{ type: 'text', text: summary }],
    };
  }

  private projectArtifact(
    result: CanonicalResult,
    _context: ProjectionContext,
  ): CallToolResult {
    // A2A responses are an envelope around one or more artifacts whose `data`
    // is typically a Message with `parts: [{ kind: 'text' | 'data' | 'file', ... }]`.
    // Each part is mapped to the most faithful MCP content block so that
    // multimodal responses (image, audio, file) survive the bridge.
    const blocks: ContentBlock[] = [];
    for (const artifact of result.artifacts) {
      extractBlocks(artifact.data, blocks);
    }
    // The MCP CallToolResult schema requires at least one content entry.
    if (blocks.length === 0) {
      blocks.push({ type: 'text', text: '' });
    }
    return { content: blocks };
  }

  private projectRaw(
    result: CanonicalResult,
    _context: ProjectionContext,
  ): CallToolResult {
    // Preserve every artifact's raw A2A data verbatim. If there is exactly
    // one artifact we emit its data directly so simple responses stay
    // uncluttered; multi-artifact responses emit the full array.
    const payload: unknown =
      result.artifacts.length === 1
        ? result.artifacts[0]!.data
        : result.artifacts.map((a) => a.data);
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: {
        ...serializeStructured(result),
        raw: payload,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers — all pure and deterministic
// ---------------------------------------------------------------------------

/**
 * Walk an A2A artifact's `data` field and append MCP content blocks for
 * every part. The output is multimodal-aware:
 *
 *   text part           → { type: "text",  text }
 *   file part + image   → { type: "image", data: base64, mimeType }
 *   file part + audio   → { type: "audio", data: base64, mimeType }
 *   file part + uri     → { type: "resource", resource: { uri, mimeType? } }
 *   file part + other   → { type: "text", text: "[file: <name>]" }   (no blob; user opt-out)
 *   data part           → { type: "text", text: JSON.stringify(data) }
 *
 * Payloads that are not a Message-shaped object fall back to a single JSON
 * text block so nothing is silently dropped.
 */
function extractBlocks(data: unknown, out: ContentBlock[]): void {
  if (typeof data === 'string') {
    out.push({ type: 'text', text: data });
    return;
  }
  if (data === null || typeof data !== 'object') {
    out.push({ type: 'text', text: JSON.stringify(data) });
    return;
  }
  const obj = data as Record<string, unknown>;
  const parts = obj['parts'];
  if (!Array.isArray(parts)) {
    out.push({ type: 'text', text: JSON.stringify(data) });
    return;
  }

  for (const part of parts) {
    if (part === null || typeof part !== 'object') continue;
    const p = part as Record<string, unknown>;
    const kind = p['kind'];

    if (kind === 'text' && typeof p['text'] === 'string') {
      out.push({ type: 'text', text: p['text'] });
      continue;
    }

    if (kind === 'data') {
      out.push({ type: 'text', text: JSON.stringify(p['data']) });
      continue;
    }

    if (kind === 'file') {
      const file = (p['file'] as Record<string, unknown> | undefined) ?? {};
      const mimeType =
        typeof file['mimeType'] === 'string' ? file['mimeType'] : undefined;
      const name = typeof file['name'] === 'string' ? file['name'] : undefined;
      const uri = typeof file['uri'] === 'string' ? file['uri'] : undefined;
      const bytes = typeof file['bytes'] === 'string' ? file['bytes'] : undefined;

      // URI-first: MCP's `resource_link` block surfaces the file to the client
      // as a reference without requiring us to inline bytes.
      if (uri !== undefined) {
        const link: {
          type: 'resource_link';
          uri: string;
          name: string;
          mimeType?: string;
        } = {
          type: 'resource_link',
          uri,
          name: name ?? uri,
        };
        if (mimeType !== undefined) link.mimeType = mimeType;
        out.push(link);
        continue;
      }

      // Inline base64 bytes only get promoted for image/audio — MCP has
      // first-class blocks for those. All other MIME types degrade to a
      // placeholder per the operator's choice (no base64 blobs).
      if (bytes !== undefined && mimeType !== undefined) {
        if (mimeType.startsWith('image/')) {
          out.push({ type: 'image', data: bytes, mimeType });
          continue;
        }
        if (mimeType.startsWith('audio/')) {
          out.push({ type: 'audio', data: bytes, mimeType });
          continue;
        }
      }

      const label = name ?? uri ?? mimeType ?? 'unnamed';
      out.push({ type: 'text', text: `[file: ${String(label)}]` });
    }
  }
}

/**
 * Deterministic JSON serialization that skips `undefined` values but preserves
 * everything else the canonical result carries.
 */
function serializeStructured(
  result: CanonicalResult,
): Record<string, unknown> {
  // Manually project fields so the output is stable regardless of whether
  // upstream code added optional properties in varying orders.
  const out: Record<string, unknown> = {
    status: result.status,
    artifacts: result.artifacts.map((a) => {
      const artifact: Record<string, unknown> = {
        type: a.type,
        data: a.data,
      };
      if (a.name !== undefined) artifact['name'] = a.name;
      return artifact;
    }),
    metadata: {
      agentUrl: result.metadata.agentUrl,
      skillId: result.metadata.skillId,
      durationMs: result.metadata.durationMs,
      correlationId: result.metadata.correlationId,
      ...(result.metadata.a2aTaskId !== undefined
        ? { a2aTaskId: result.metadata.a2aTaskId }
        : {}),
    },
  };
  if (result.taskId !== undefined) out['taskId'] = result.taskId;
  if (result.taskState !== undefined) out['taskState'] = result.taskState;
  return out;
}

function buildTextFallback(result: CanonicalResult): string {
  if (result.taskId !== undefined) {
    return `Task ${result.taskId} (${result.taskState ?? 'unknown'}). Use task_status to check progress.`;
  }
  const count = result.artifacts.length;
  return `${result.status}: ${count} artifact${count === 1 ? '' : 's'} from ${result.metadata.skillId} on ${result.metadata.agentUrl}`;
}

function buildCompactSummary(result: CanonicalResult): string {
  const base =
    result.taskId !== undefined
      ? `Task ${result.taskId} (${result.taskState ?? 'unknown'}).`
      : `${result.status}: ${result.artifacts.length} artifact(s) from ${result.metadata.skillId}.`;
  return base.length <= COMPACT_SUMMARY_LIMIT
    ? base
    : base.slice(0, COMPACT_SUMMARY_LIMIT);
}
