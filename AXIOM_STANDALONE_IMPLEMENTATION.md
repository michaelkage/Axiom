# Axiom standalone architecture

This document describes the current product boundary. It replaces the earlier migration plan, which assumed extension-specific build and test paths would temporarily remain.

## Product contract

Axiom is a standalone Electron desktop application for AI-first software building. The user installs Axiom, selects a project folder, configures a model provider, delegates scoped tasks, reviews changes, and checks actual verification evidence. No VS Code installation or extension runtime is required.

## Runtime boundaries

- **Electron host:** `desktop/main.cjs` owns app lifecycle, workspace selection, local OpenCode process lifecycle, and validated IPC handlers.
- **Preload bridge:** `desktop/preload.cjs` exposes only explicitly supported desktop capabilities. The renderer has no Node integration.
- **Renderer:** `src/webview/standalone.html` is the only production UI entry point. It loads the SolidJS application and connects to the local runtime.
- **OpenCode runtime:** started for the selected project and bound to `127.0.0.1`. Axiom owns the runtime process it launches and stops it during shutdown.
- **Task execution:** planner and worker orchestration track task scope, worktree/session identity, cancellation, review, and verification evidence.
- **Local state:** project history and memory are stored in application user data. Provider credentials use OS-backed secure storage where available.
- **Optional OmniRoute:** can be connected or managed explicitly by the user. It is not required for direct provider configuration.

## Security and reliability invariants

- Keep `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- Validate IPC sender identity, message shape, path boundaries, and payload limits.
- Reject workspace path traversal and avoid following symlinks outside the selected project.
- Never expose arbitrary shell execution directly to the renderer.
- Bind local services to loopback, not public interfaces.
- Treat cancellation and shutdown as explicit lifecycle states.
- Integrate worker changes only after review and successful required checks. Dirty destination files and conflicts must block unsafe integration.
- Keep runtime logs useful for startup failures and package smoke tests.

## Verification and release

CI builds the standalone renderer, type-checks it, runs unit tests, and runs desktop host tests. The Windows release workflow additionally packages the installer, installs it on a Windows runner, launches the installed application, verifies runtime and renderer readiness, generates a checksum, and publishes a GitHub Release only after the workflow succeeds.

See [README.md](./README.md) for build commands and [desktop troubleshooting](./docs/DESKTOP_TROUBLESHOOTING.md) for operational recovery.
