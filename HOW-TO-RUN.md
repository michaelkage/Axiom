# Develop Axiom locally

Axiom's product target is the standalone desktop application. Start with [README.md](./README.md) for user installation, architecture, and release details.

## Requirements

- Node.js 20
- pnpm 10, matching the root `package.json`
- npm for Electron desktop packaging
- Git for worktree-based task isolation and review
- Windows x64 to build/test the current official installer target

## Build the standalone UI

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build:webview
```

This generates `out/standalone.html` and its assets.

## Run automated checks

```bash
pnpm exec vitest run
pnpm exec tsc -p tsconfig.webview.json
pnpm exec tsc -p tsconfig.extension.json --noEmit
node --check desktop/main.cjs
```

The full `pnpm test` script also runs Playwright browser tests. Those tests may need browser/runtime dependencies installed for your environment.

## Launch the desktop app

```bash
pnpm install --frozen-lockfile
pnpm run build:webview
cd desktop
npm install
npm start
```

Axiom opens a native folder picker, starts its local OpenCode runtime for the selected project, and loads the standalone workspace. If runtime startup fails, inspect the error dialog and verify the local runtime dependency was installed correctly.

## Build the Windows installer

Run from the repository root:

```bash
pnpm run build:webview
cd desktop
npm install
npm run dist
```

The Windows x64 installer is written to `desktop/release/`. The release workflow runs this packaging on a Windows GitHub Actions runner.

## Troubleshooting

### The desktop window does not open

- Confirm `out/standalone.html` exists after running `pnpm run build:webview`.
- Run `node --check desktop/main.cjs` to catch launcher syntax errors.
- Start with `npm start` from `desktop/` and inspect terminal output.

### The local runtime fails to start

- Verify the bundled `opencode-ai` package installed without errors in `desktop/node_modules`.
- Check that the selected project folder is readable and writable.
- Confirm the local runtime can bind to a loopback port and that endpoint security software is not blocking it.

### Agent tasks or quality checks fail

- Confirm Git is installed and the project is inside a Git repository for worktree isolation.
- Make sure dependencies can be installed in the target project.
- Read the exact quality-gate command output; do not treat an agent completion message as proof that checks passed.

## Useful locations

- `desktop/main.cjs`: Electron launcher, workspace selection, and local runtime lifecycle
- `desktop/package.json`: desktop dependencies and installer configuration
- `src/webview/standalone.html`: desktop UI entry point
- `src/webview/App.tsx`: primary workspace UI
- `src/webview/components/WorktreeReviewPanel.tsx`: task review and selective integration
- `src/shared/axiomWorkflow.ts`: shared workflow helpers and tests
- `.github/workflows/axiom-ci.yml`: automated CI
- `.github/workflows/release.yml`: standalone Windows release packaging
