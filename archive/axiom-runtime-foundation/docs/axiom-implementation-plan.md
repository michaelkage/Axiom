# Axiom runtime implementation plan

## Repository audit (baseline)

Inspected the public `michaelkage/Axiom` repository on its `main` branch before changes.

- The codebase is a VS Code webview extension based on OpenCode SDK v2, not a standalone `src/backend` + `src/webview` application as the architecture blueprint's example paths imply.
- Existing integration points are `src/extension.ts`, `src/OpenCodeService.ts`, `src/OpenCodeViewProvider.ts`, and the SolidJS workspace under `src/webview`.
- `package.json` already contains a SolidJS webview, Vite build, and Vitest/Playwright tests.
- The blueprint's `src/shared/services/axiomConfig.ts` and `src/backend/agents/orchestrator.ts` are proposals, not existing files in this repository.
- The existing OpenCode service launches the OpenCode server on a dynamic local port. OmniRoute should therefore be a separate, configurable model-planning/worker gateway rather than replacing the OpenCode server URL used by the chat UI.

## Implemented in this change

1. `src/axiom/axiomConfig.ts`: typed VS Code settings with safe local defaults and bounded worker/time-out values.
2. `src/axiom/omniRouteClient.ts`: OpenAI-compatible `/models` health probe and `/chat/completions` client, request timeout, cancellation, and explicit errors.
3. `src/axiom/orchestrator.ts`: JSON plan validation, dependency/cycle checks, bounded parallel execution, cancellation, and per-task status callbacks. Worker execution is injected so it can be wired to the repository's actual agent/session API without fabricating an execution backend.
4. `src/axiom/errorHealing.ts`: gathers a bounded diagnostic context and requests a structured repair suggestion. It presents a reviewable diff; it deliberately does not mutate files autonomously.
5. VS Code settings and command wiring, plus a runtime dashboard to make gateway status and orchestration availability visible in the existing developer workspace.

## Blueprint coverage and gaps

| Blueprint pillar | Status | Notes |
|---|---|---|
| OmniRoute telemetry and combos | Foundation | Configurable gateway, model settings, and health latency; token-compression telemetry requires gateway-specific response metadata and is not inferred. |
| Multi-agent parallelization | Foundation | Planner and bounded dependency-aware executor exist; real worker execution must be connected to an approved OpenCode session/task adapter. |
| Local error healing | Guarded foundation | Diagnostic-to-suggestion pipeline; no automatic patch application. Automatic mutation would need explicit policy, diff validation, tests, and user approval. |
| Extensible plugin layer | Existing extension points retained | Runtime service is isolated from the existing OpenCode chat transport. |
| Visual Operator Workspace | Dashboard foundation | Runtime state is shown in a VS Code webview panel; full live task telemetry depends on connecting orchestration callbacks to a persistent runtime. |

## Validation

- Run `pnpm install` then `pnpm build`.
- Run `pnpm test`.
- In VS Code, set `axiom.gatewayUrl` (default `http://127.0.0.1:20128/v1`) and run **Axiom: Open Runtime Dashboard**.
- Use **Axiom: Check OmniRoute Gateway** to test `GET /models`.
- A healthy HTTP response confirms the gateway endpoint responds; it does not guarantee that a specific planner/worker model alias exists.

## Follow-up work

- Implement an OpenCode session-backed `WorkerExecutor` with per-task session IDs and cancellation.
- Subscribe to compiler/test diagnostics and feed only scoped, redacted context into the repair pipeline.
- Add gateway-specific token usage/compression telemetry when OmniRoute's response schema is confirmed.
- Add unit tests for malformed planner output, dependency cycles, cancellation, timeout handling, and repair JSON parsing.
