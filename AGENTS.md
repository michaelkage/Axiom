# Axiom contributor guide

Axiom is a standalone Electron desktop app for AI-first software building. The product does not have a VS Code extension or editor-host runtime. Keep the Electron host, standalone SolidJS renderer, and local OpenCode runtime boundaries explicit.

## Common commands

- Install workspace dependencies: `pnpm install --frozen-lockfile`
- Build the standalone renderer: `pnpm run build:webview`
- Run unit tests: `pnpm exec vitest run`
- Type-check renderer: `pnpm exec tsc -p tsconfig.webview.json`
- Run desktop host tests: `pnpm run test:desktop`
- Run browser tests: `pnpm run test:e2e`
- Build and launch desktop app: `pnpm run desktop:dev`
- Build Windows installer: `pnpm run desktop:dist`

## Architecture

- `desktop/main.cjs`: Electron lifecycle, local runtime process, project selection, IPC, and shutdown.
- `desktop/preload.cjs`: narrow, validated renderer bridge.
- `desktop/terminal.cjs`, `desktop/filesystem.cjs`, `desktop/project-store.cjs`, `desktop/omniroute.cjs`: desktop capabilities.
- `src/webview/standalone.html` and `src/webview/main.tsx`: the single renderer entry point.
- `src/shared/`: shared runtime contracts and workflow helpers.
- `tests/e2e/`: browser-level behavior tests.
- `.github/workflows/axiom-ci.yml`: UI build, type checks, unit tests, and desktop host tests.
- `.github/workflows/release.yml`: Windows packaging, installed-app smoke test, checksum, and release publication.

## Implementation rules

- Do not reintroduce VS Code APIs, extension manifests, extension packaging, or extension-host fallbacks.
- Keep renderer access to Node.js disabled; use the narrow preload bridge and validate IPC inputs.
- Bind the OpenCode server to loopback only.
- Treat user project files as untrusted input. Validate paths, bound payload sizes, and avoid following symlinks across workspace boundaries.
- Worker completion must be based on runtime evidence and verification output, not an agent's claim alone.
- Preserve user changes. Require review and verification before integrating task worktrees.
- Add tests for behavior changes, especially cancellation, runtime startup/shutdown, project switching, and packaging.
- Keep README and desktop troubleshooting instructions aligned with the actual standalone app.
