# Develop Axiom locally

For the product overview, user installation, architecture, and release process, start with [README.md](./README.md).

## Requirements

- Node.js 20
- pnpm 10, matching the version pinned in `package.json`
- Visual Studio Code
- Git

## Install and build

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build
```

## Run automated checks

```bash
pnpm exec vitest run
pnpm exec tsc -p tsconfig.webview.json
pnpm exec tsc -p tsconfig.extension.json --noEmit
```

The full `pnpm test` script also runs Playwright browser tests. Those tests may need the browser/runtime dependencies installed for your environment.

## Launch the extension

1. Open the repository folder in VS Code.
2. Open **Run and Debug**.
3. Choose the extension launch configuration and press **F5**.
4. In the Extension Development Host window, open the **Axiom** view in the Activity Bar.
5. Connect/configure a supported model provider and try a small request before running a multi-task plan.

If the launch configuration is missing, inspect `.vscode/launch.json` and `.vscode/tasks.json` before creating replacements. Keep the normal build working while changing development tooling.

## Watch mode

```bash
pnpm run watch
```

This runs the extension and webview builds in watch mode. Stop it with Ctrl+C when finished.

## Troubleshooting

### The view is blank

- Run `pnpm run build` and check the terminal for the first build error.
- In the Extension Development Host, run **Developer: Reload Window**.
- Open **Developer: Toggle Developer Tools** and inspect the console for webview errors.

### The extension does not activate

- Confirm `dist/extension.js` exists after building.
- Check the Extension Development Host's **Output** and **Debug Console** panels.
- Verify the extension launch configuration points at this repository.

### Task worktree checks fail

- Confirm Git is installed and the workspace is inside a Git repository.
- Make sure dependencies can be installed with `pnpm install --frozen-lockfile`.
- Read the exact quality-gate command output; do not treat the agent's completion message as a passing check.

### The installer cannot install the VSIX

The Windows installer retains the VSIX under the user's local Axiom application folder. In VS Code, open **Extensions**, choose **Install from VSIX...**, and select that file. The `.vsix` release asset can also be installed directly.

## Useful locations

- `src/extension.ts`: extension entry point
- `src/OpenCodeViewProvider.ts`: VS Code integration, task worktrees, inspection, and quality checks
- `src/webview/App.tsx`: primary workspace UI
- `src/webview/components/WorktreeReviewPanel.tsx`: task review and selective integration
- `src/shared/axiomWorkflow.ts`: shared workflow helpers and tests
- `.github/workflows/axiom-ci.yml`: automated CI
- `.github/workflows/release.yml`: tagged Windows release packaging
