# Axiom workflow foundations

This document records the implemented foundation and the remaining integration work. It intentionally distinguishes observed runtime behavior from future architecture.

## User-visible workflow

- `ChangeTopicsPanel` groups session diff metadata into plain-language topics, lists affected paths, and expands before/after snapshots into a reviewable diff view when the SDK supplies those snapshots.
- `VerificationPanel` derives results only from observed shell/command tool parts. Completed command output and tool error state determine pass/fail; a response ending is never itself a pass.
- Once a plan-driven run finishes, checks with no observed completed result are shown as skipped. The current baseline reports Tests and Build; richer plan-specific check selection should replace this default.
- `RecoveryAdvice` classifies common connection, timeout, rate-limit, local-model, permission, and tool errors. The retry button is explicit; commands that may have side effects are not automatically replayed.
- OmniRoute requests have a configurable timeout and bounded retries for classified transient failures only.

## Runtime foundations

- `src/shared/axiomRuntime.ts` contains the local OmniRoute default endpoint, telemetry shape, measured-token compression calculation, task dependency validation/batching, and an HTTP helper. It does not silently reroute the existing OpenCode SDK traffic.
- `src/shared/pluginRegistry.ts` provides a lifecycle-managed in-process plugin registry and typed context. It is a contract/foundation, not a sandbox: do not load untrusted third-party plugins until process isolation and permission mediation exist.
- `createIndependentTasks` computes dependency-safe parallel batches; actual agent spawning, isolated worktrees, conflict resolution, and synthesis still need to be connected to OpenCode's supported subagent/session APIs.
- Compression percentages must be based on measured input and compressed token counts. No savings are claimed when those values are unavailable.
- Recovery defaults to notification/manual action for local-model format errors, permissions, and tool commands because automatic replay can duplicate side effects.

## Validation

Unit tests cover change grouping/diff generation, observed verification status, recovery classification, task graph validation, compression math, and plugin lifecycle. A build and test run still needs to be executed in a network-enabled checkout; this environment cannot resolve `github.com`, so dependency installation and compilation are not claimed as verified.
