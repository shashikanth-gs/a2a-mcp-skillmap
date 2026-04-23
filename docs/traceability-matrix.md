# Traceability Matrix

Maps every requirement to the design sections, implementation files, and test files that realize and validate it.

## Agent resolution (1.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 1.1 | §AgentRegistry | `src/core/registry.ts` | `tests/unit/agent-registry.test.ts`, `tests/integration/bridge-pipeline.test.ts` |
| 1.2 | §SkillNormalizer, §AgentResolver | `src/a2a/skill-normalizer.ts`, `src/a2a/agent-resolver.ts` | `tests/property/agent-resolver.property.test.ts` (Property 15), `tests/unit/skill-normalizer.test.ts` |
| 1.3 | §RegistryStore | `src/storage/memory-registry-store.ts` | `tests/property/registry-store.property.test.ts` (Property 14) |
| 1.4 | §ToolGenerator | `src/core/tool-generator.ts` | `tests/property/tool-generator.property.test.ts` (Property 4) |
| 1.5 | §Retry strategy | `src/core/registry.ts` | `tests/unit/agent-registry.test.ts` |
| 1.6 | §Graceful degradation | `src/a2a/agent-resolver.ts` | `tests/unit/agent-resolver.test.ts` |
| 1.7 | §AgentResolver | `src/a2a/agent-resolver.ts` | `tests/unit/agent-resolver.test.ts`, `tests/property/agent-resolver.property.test.ts` |
| 1.8 | §AgentRegistry — atomic refresh | `src/core/registry.ts` | `tests/unit/agent-registry.test.ts` |
| 1.9 | §AgentRegistry | `src/core/registry.ts` | `tests/unit/agent-registry.test.ts` |

## Tool generation (2.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 2.1 | §ToolGenerator | `src/core/tool-generator.ts` | `tests/property/tool-generator.property.test.ts` (Property 4), `tests/integration/bridge-pipeline.test.ts` |
| 2.2 | §ToolNamingStrategy | `src/core/tool-naming.ts` | `tests/property/tool-naming.property.test.ts` (Property 1) |
| 2.3 | §ToolNamingStrategy collision handling | `src/core/tool-generator.ts`, `src/core/tool-naming.ts` | `tests/property/tool-naming.property.test.ts` (Property 2), `tests/unit/tool-generator.test.ts` |
| 2.4 | §SkillNormalizer | `src/a2a/skill-normalizer.ts` | `tests/property/skill-normalizer.property.test.ts` (Property 5) |
| 2.5 | §ToolGenerator metadata | `src/core/tool-generator.ts` | `tests/property/tool-generator.property.test.ts` (Property 4) |
| 2.6 | §SkillNormalizer rejection | `src/a2a/skill-normalizer.ts` | `tests/unit/skill-normalizer.test.ts` |
| 2.7 | §ToolNamingStrategy format | `src/core/tool-naming.ts` | `tests/property/tool-naming.property.test.ts` (Property 3) |

## Transport (3.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 3.1 | §Stdio transport adapter | `src/mcp/stdio-server.ts` | `tests/integration/stdio-adapter.test.ts` |
| 3.2 | §HTTP transport adapter | `src/mcp/http-server.ts` | `tests/integration/http-adapter.test.ts` |
| 3.3 | §HTTP auth middleware | `src/mcp/http-server.ts` | `tests/integration/http-adapter.test.ts` |
| 3.4 | §Stdio transport adapter | `src/mcp/stdio-server.ts` | `tests/integration/stdio-adapter.test.ts` |
| 3.5 | §HTTP transport — port error | `src/mcp/http-server.ts` | `tests/integration/http-adapter.test.ts` |
| 3.6 | §Task tools | `src/core/engine.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 3.7 | §CLI | `src/cli/index.ts` | `tests/unit/cli.test.ts`, `tests/integration/cli-run.test.ts` |

## Invocation (4.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 4.1 | §InvocationRuntime | `src/core/invocation-runtime.ts` | `tests/property/invocation-runtime.property.test.ts` (Property 6), `tests/integration/bridge-pipeline.test.ts` |
| 4.2 | §Input validation gate | `src/core/invocation-runtime.ts` | `tests/property/invocation-runtime.property.test.ts` (Property 6) |
| 4.3 | §Input validation gate | `src/core/invocation-runtime.ts` | `tests/property/invocation-runtime.property.test.ts` (Property 6) |
| 4.4 | §Fast-path/long-path dispatch | `src/core/invocation-runtime.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 4.5 | §Fast-path | `src/core/invocation-runtime.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 4.6 | §Long-path | `src/core/invocation-runtime.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 4.7 | §Error handling — A2A protocol | `src/core/invocation-runtime.ts` | `tests/unit/engine-branches.test.ts` |

## Tasks (5.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 5.1 | §Sync budget logic | `src/core/invocation-runtime.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 5.2 | §TaskManager | `src/core/task-manager.ts` | `tests/unit/task-manager.test.ts` |
| 5.3 | §task.status | `src/core/engine.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 5.4 | §task.result | `src/core/engine.ts` | `tests/unit/engine-branches.test.ts` |
| 5.5 | §task.cancel | `src/core/engine.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 5.6 | §Task state machine | `src/core/task-manager.ts` | `tests/property/task-manager.property.test.ts` (Property 7) |
| 5.7 | §Task state machine | `src/core/task-manager.ts` | `tests/property/task-manager.property.test.ts` (Property 7) |
| 5.8 | §Task eviction | `src/core/task-manager.ts` | `tests/unit/task-manager.test.ts` |
| 5.9 | §task.cancel on terminal | `src/core/engine.ts`, `src/core/task-manager.ts` | `tests/unit/task-manager.test.ts` |
| 5.10 | §Task tools error paths | `src/core/engine.ts` | `tests/integration/bridge-pipeline.test.ts` |

## Response projection (6.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 6.1 | §ResponseProjector | `src/core/response-projector.ts` | `tests/unit/response-projector.test.ts` |
| 6.2 | §structured mode | `src/core/response-projector.ts` | `tests/property/response-projector.property.test.ts` (Property 8) |
| 6.3 | §compact mode | `src/core/response-projector.ts` | `tests/property/response-projector.property.test.ts` (Property 8) |
| 6.4 | §raw mode | `src/core/response-projector.ts` | `tests/property/response-projector.property.test.ts` (Property 8) |
| 6.7 | §Schema validity | `src/core/response-projector.ts` | `tests/property/response-projector.property.test.ts` (Property 9) |

## Inbound auth (7.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 7.1 | §NoopInboundAuth | `src/auth/inbound/index.ts` | `tests/unit/auth.test.ts` |
| 7.2 | §BearerInboundAuth | `src/auth/inbound/index.ts` | `tests/unit/auth.test.ts` |
| 7.3 | §ApiKeyInboundAuth | `src/auth/inbound/index.ts` | `tests/unit/auth.test.ts` |
| 7.4 | §401 + structured error body | `src/mcp/http-server.ts` | `tests/integration/http-adapter.test.ts` |
| 7.5 | §Credential redaction | `src/auth/inbound/index.ts`, `src/config/loader.ts` | `tests/property/auth-redaction.property.test.ts` (Property 11) |
| 7.6 | §Credentials from env/config only | `src/cli/index.ts` | `tests/unit/cli.test.ts` |
| 7.7 | §HTTP transport | `src/mcp/http-server.ts` | `tests/integration/http-adapter.test.ts` |

## Outbound auth (8.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 8.1 | §NoopAgentAuth | `src/auth/outbound/index.ts` | `tests/unit/auth.test.ts` |
| 8.2 | §BearerAgentAuth | `src/auth/outbound/index.ts` | `tests/unit/auth.test.ts` |
| 8.3 | §ApiKeyAgentAuth | `src/auth/outbound/index.ts` | `tests/unit/auth.test.ts` |
| 8.4 | §redactedDescription | `src/auth/outbound/index.ts` | `tests/property/auth-redaction.property.test.ts` (Property 11) |
| 8.5 | §Auth provider interface | `src/types/index.ts`, `src/auth/outbound/index.ts` | `tests/unit/auth.test.ts` |
| 8.6 | §Credential redaction | `src/auth/outbound/index.ts` | `tests/property/auth-redaction.property.test.ts` (Property 11) |
| 8.7 | §Misconfig handling | `src/auth/outbound/index.ts` | `tests/unit/auth.test.ts` |

## Packaging (9.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 9.1–9.2 | §package.json, §bin | `package.json`, `src/cli/index.ts` | Manual: `node dist/cli/index.js --help` |
| 9.3 | §exports | `package.json`, `src/index.ts` | Manual |
| 9.4 | §createBridge | `src/core/create-bridge.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 9.5 | §engines | `package.json` | Manual |
| 9.6–9.7 | §ESM module format | `package.json`, `tsconfig.json` | Manual |

## Extensibility (10.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 10.1 | §createBridge options | `src/core/create-bridge.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 10.2 | §Pluggable projector | `src/core/create-bridge.ts`, `src/core/response-projector.ts` | `tests/integration/bridge-pipeline.test.ts` |
| 10.3 | §Pluggable naming | `src/core/tool-generator.ts`, `src/core/tool-naming.ts` | `tests/unit/tool-generator.test.ts` |
| 10.4 | §Pluggable storage | `src/storage/` | `tests/property/registry-store.property.test.ts`, `tests/property/task-store.property.test.ts` |
| 10.5 | §Naming strategy | `src/core/tool-naming.ts` | `tests/property/tool-naming.property.test.ts` |
| 10.6 | §Custom auth providers | `src/auth/` | `tests/unit/auth.test.ts` |

## Determinism (11.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 11.1 | §Tool name determinism | `src/core/tool-naming.ts` | `tests/property/tool-naming.property.test.ts` (Property 1) |
| 11.2 | §Response determinism | `src/core/response-projector.ts` | `tests/property/response-projector.property.test.ts` (Property 10) |
| 11.3 | §Format conformance | `src/core/tool-naming.ts` | `tests/property/tool-naming.property.test.ts` (Property 3) |
| 11.4 | §Versioning policy | `CHANGELOG.md`, `docs/contributor-guide.md` | Manual |

## Observability (12.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 12.1 | §Structured logging | `src/core/logger.ts` | `tests/property/observability.property.test.ts` (Property 17) |
| 12.2 | §Telemetry | `src/core/telemetry.ts` | `tests/unit/telemetry.test.ts` |
| 12.3 | §Correlation ID | `src/core/logger.ts` | `tests/property/observability.property.test.ts` (Property 17) |
| 12.4 | §OpenTelemetry bridge | `src/core/telemetry.ts` | `tests/unit/telemetry.test.ts` |
| 12.5 | §Credential redaction | `src/core/logger.ts`, `src/config/loader.ts` | `tests/property/auth-redaction.property.test.ts` (Property 11) |
| 12.6 | §Telemetry hooks | `src/core/telemetry.ts` | `tests/unit/telemetry.test.ts` |

## Quality gates (13.x / 14.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 13.3 | §Coverage thresholds | `vitest.config.ts` | CI run |
| 13.5 | §CI pipeline | `.github/workflows/ci.yml` | CI run |
| 14.1 | §Strict TypeScript | `tsconfig.json` | `npm run lint` |
| 14.2 | §Linting | `eslint.config.js` | `npm run lint` |
| 14.3 | §Validation gate | `src/core/invocation-runtime.ts` | `tests/property/invocation-runtime.property.test.ts` |
| 14.4 | §Review gate | `docs/contributor-guide.md`, CI | Policy |
| 14.5 | §Semantic versioning | `CHANGELOG.md`, `docs/contributor-guide.md` | Policy |

## ADRs & docs (15.x / 16.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 15.1 | §Versioning | `CHANGELOG.md` | Manual |
| 15.2 | §Directory structure | `src/`, `tests/`, `docs/` | Manual |
| 15.3 | §ADRs | `docs/adr/` | Manual |
| 15.4 | §Changelog | `CHANGELOG.md` | Manual |
| 15.5 | §Traceability | This document | Manual |
| 16.1 | §README | `README.md` | Manual |
| 16.2 | §API reference | `docs/api-reference.md` | Manual |
| 16.3 | §CLI reference | `docs/cli-reference.md` | Manual |
| 16.4 | §Operator guide | `docs/operator-guide.md` | Manual |
| 16.5 | §Contributor guide | `docs/contributor-guide.md` | Manual |
| 16.6 | §Security | `docs/security.md` | Manual |
| 16.7 | §Repo files | `LICENSE`, `CODE_OF_CONDUCT.md` | Manual |

## Config (17.x / 18.x)

| Req | Design | Implementation | Tests |
|---|---|---|---|
| 17.1 | §Config loader | `src/config/loader.ts` | `tests/unit/config-loader.test.ts` |
| 17.2 | §Precedence | `src/config/loader.ts` | `tests/property/config.property.test.ts` (Property 16) |
| 17.3 | §Schema validation | `src/config/schema.ts` | `tests/unit/config-schema.test.ts` |
| 17.4 | §Validation errors | `src/config/loader.ts` | `tests/unit/config-loader.test.ts`, `tests/integration/cli-run.test.ts` |
| 17.5 | §Credential redaction | `src/config/loader.ts` | `tests/property/auth-redaction.property.test.ts` (Property 11) |
| 18.1 | §Config round-trip | `src/config/schema.ts` | `tests/property/config.property.test.ts` (Property 12) |
| 18.2 | §Config round-trip | `src/config/schema.ts` | `tests/property/config.property.test.ts` (Property 12) |
| 18.3 | §Task serialization | `src/types/index.ts`, `src/storage/memory-task-store.ts` | `tests/property/task-store.property.test.ts` (Property 13) |
| 18.4 | §Task serialization | `src/storage/memory-task-store.ts` | `tests/property/task-store.property.test.ts` (Property 13) |
| 18.5 | §Schema-valid output | `src/core/response-projector.ts` | `tests/property/response-projector.property.test.ts` (Property 9) |
