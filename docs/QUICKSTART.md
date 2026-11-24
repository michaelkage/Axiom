# Axiom quick start

Axiom is a standalone Windows desktop app. You do not need VS Code, an extension development host, or a separate editor installation.

## Install and launch

1. Open the [Axiom Releases page](https://github.com/michaelkage/Axiom/releases).
2. Download the latest `Axiom-Setup-<version>-x64.exe` asset.
3. Install and launch Axiom from the Start menu or desktop shortcut.
4. Choose a project folder.
5. Configure your hosted or local model provider in the app.
6. Describe a concrete coding task, review the plan and acceptance criteria, then inspect the task changes and verification output before integrating them.

If no installer is attached to a published release, the release is not ready yet. CI artifacts are not published releases.

## Build from source

Requirements: Node.js 20, pnpm 10, npm, and Git for worktree-based task isolation.

```bash
pnpm install --frozen-lockfile
pnpm run build:webview
pnpm exec tsc -p tsconfig.webview.json
pnpm exec vitest run
pnpm run test:desktop
```

To run the Electron app locally:

```bash
cd desktop
npm install
npm start
```

To build a Windows installer from the repository root:

```bash
pnpm run desktop:dist
```

For provider setup, startup recovery, logs, and known limitations, see [Desktop troubleshooting](./docs/DESKTOP_TROUBLESHOOTING.md). The main [README](./README.md) contains the full product and development guide.
