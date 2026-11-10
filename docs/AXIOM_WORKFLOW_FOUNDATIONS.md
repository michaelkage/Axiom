# Axiom workflow runtime

This document separates implemented behavior, automated coverage, and runtime requirements that still need an installed local gateway/OpenCode environment.

## User-visible workflow

- `ChangeTopicsPanel` groups session diff metadata into plain-language topics, lists affected paths, and expands supplied before/after snapshots into a contextual unified diff.
- `VerificationPanel` derives results from observed shell/command tool parts. A tool-call completion alone is not a pass: Axiom requires a reported zero exit code for Passed, a non-zero exit or tool error for Failed, and marks missing exit evidence Unverified/Skipped.
- Plan-driven runs list checks without verified outcomes as skipped. The current default checks are Tests and Build; richer plan-specific check selection remains future work.
- `RecoveryAdvice` classifies connection, timeout, rate-limit, local-model/format, permission, tool, and unknown errors. Startup, session creation, and prompt submission failures are surfaced. Retry is explicit, and side-effecting commands are not automatically replayed.

## OmniRoute and parallel tasks

- The plan panel has an explicit **Plan with OmniRoute** action. It discovers a model from the configured OpenAI-compatible local gateway's `/models` endpoint, asks `/chat/completions` for a structured task graph, and validates IDs, dependencies, and target-file declarations.
- **Run with parallel agents** creates OpenCode child sessions and submits task-scoped prompts. Dependency layers execute in order; independent tasks run concurrently. Tasks with overlapping declared target paths are deferred to separate batches to reduce write conflicts.
- After child tasks finish, Axiom asks the parent session to inspect and integrate the workspace changes and run relevant checks. If a batch fails, later dependency layers are not started; already-started siblings may have changed files, so the UI explicitly warns the user to review the workspace before retrying.
- This is an opt-in path. It requires an accessible local OmniRoute-compatible gateway at `http://127.0.0.1:20128/v1` and an initialized OpenCode runtime. GitHub CI validates planner parsing, dependency-safe scheduling, conflict-aware batching, and the build; it does not run against a live local gateway or verify actual child-agent edits end to end.
- `requestOmniRoute` applies timeouts and bounded retries only to classified transient errors. The existing normal OpenCode SDK request path is not silently rerouted through OmniRoute.
- Token-compression percentage is computed only from measured input and compressed token counts. No savings are reported without measurements.

## Plugins and remaining limitations

- `src/shared/pluginRegistry.ts` provides a lifecycle-managed in-process plugin registry and typed context. It is not a sandbox; do not load untrusted third-party plugins until process isolation and permission mediation exist.
- Task target-file isolation is advisory: agents can still modify undeclared files. Review the final workspace diff and verification panel before accepting changes.
- Parallel task orchestration does not yet provide isolated worktrees, automatic merge/conflict resolution, or live per-agent token/latency/compression telemetry. Those must be added before presenting the feature as fully isolated or cost-optimized.

## Validation

GitHub Actions runs dependency installation, production build, webview type-check, extension type-check, and Vitest unit tests. The test suite covers diff generation, verification evidence, recovery classification, OmniRoute planning through a mocked OpenAI-compatible response, task graph validation, conflict-aware batch scheduling, and plugin lifecycle. A successful CI run proves these checks in GitHub's environment, not the availability or behavior of a user's local model gateway.
