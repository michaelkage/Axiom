# Axiom quick start

Axiom is a standalone Electron desktop app for AI-first project building. It does not require VS Code, an extension development host, or a separate editor installation.

## Install and launch

1. Open the [Axiom Releases page](https://github.com/michaelkage/Axiom/releases).
2. Download the package for your platform: Windows x64 installer, Linux AppImage/DEB/RPM, or a signed macOS DMG when one is published.
3. Install or launch Axiom and choose a project folder.
4. Configure your hosted or local model provider in the app.
5. Describe a concrete coding task.
6. Review the plan and acceptance criteria, then inspect task changes and verification output before integrating them.

A CI artifact is not a published release. If a platform package is not attached to the Releases page, it is not yet available as a published download.

## Build from source

Requirements: Node.js 20+, pnpm 10, npm, and Git for worktree-based task isolation.

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

For provider setup, startup recovery, logs, and known limitations, see [Desktop troubleshooting](./DESKTOP_TROUBLESHOOTING.md). The [main README](../README.md) contains the product and development overview.
