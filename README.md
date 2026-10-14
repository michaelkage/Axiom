# Axiom

**Build software by describing the outcome, not by starting with a pile of files.**

Axiom is an AI-first project-building workspace being developed as a Visual Studio Code extension. Describe a feature or a change in plain language, let the planner break it into scoped work, and review the result through task summaries, diffs, and verification evidence. Code and Git details stay available when you need them, rather than being the whole product.

> **Project status:** active development. Axiom is not yet a standalone desktop IDE. The current deliverable is a VS Code extension; Windows releases include an installer wrapper and the installable `.vsix` package.

## What Axiom is aiming to do

- **Start with outcomes.** Describe what the project should do or what should change.
- **Plan work before editing.** Split larger requests into scoped tasks, acceptance criteria, dependencies, and parallel work where safe.
- **Keep agent work reviewable.** Work is isolated in Git worktrees where supported, so task changes can be inspected before integration.
- **Verify instead of guessing.** The quality gate runs relevant checks against the task worktree and reports actual command output. An agent saying “done” is not proof that the build passes.
- **Recover deliberately.** Failed checks can be sent back through a bounded repair attempt with the failure evidence.
- **Integrate selectively.** Review changed files and diffs, select what to integrate, and avoid blindly overwriting unrelated local edits.
- **Keep project context handy.** A project memory panel lets you save, search, edit, and delete conventions, decisions, architecture notes, and fixes. Current memory storage is browser/webview-local, not automatically synced between machines.
- **Finish with a useful result.** See task outcomes, blockers, outstanding work, and the evidence available for review.

These capabilities are evolving. The repository contains legacy OpenCode-oriented extension infrastructure and identifiers alongside the Axiom product work; not every screen or string has been fully rebranded yet.

## Install

### Windows

1. Open the [Axiom Releases page](https://github.com/michaelkage/Axiom/releases).
2. Download **Axiom-Setup-`version`-x64.exe** to use the installer, or download the **`.vsix`** file for manual installation.
3. Run the installer. It attempts to install the extension into Visual Studio Code.
4. If the installer cannot find the VS Code command-line tool, it keeps the VSIX under your local Axiom application folder and tells you where it is. In VS Code, open **Extensions**, choose **Install from VSIX...**, and select that file.
5. Reload VS Code and open the Axiom view from the Activity Bar.

The Windows installer and VSIX are produced by the tagged-release workflow. If the Releases page has no published release yet, the packaging workflow has not published one. Do not mistake a build artifact for a published release; GitHub has enough ways to confuse people already.

### Install a VSIX manually

From a terminal with VS Code's `code` CLI available:

```powershell
code --install-extension .\axiom-<version>.vsix
```

Or use **Extensions → … → Install from VSIX...** in VS Code.

## Quick start

1. Open a project folder in VS Code.
2. Open the Axiom view in the Activity Bar.
3. Configure/connect a supported model provider using the available provider controls.
4. Describe a concrete outcome, for example: “Add CSV export to the reports page, include tests, and explain the files changed.”
5. Review the generated plan and task scopes. Larger requests may be split into dependent tasks.
6. Inspect each task's changed files, diff, acceptance criteria, and quality-gate output.
7. Mark criteria reviewed and integrate only the changes you want. A successful agent response is not the same thing as a passed quality gate.

Start with a small change the first time so you can confirm your provider, permissions, and local toolchain are configured correctly.

## Development setup

### Requirements

- Node.js 20
- pnpm 10 (the version declared by `package.json`)
- Visual Studio Code for running the extension
- Git for worktree-based task isolation and change review

### Install dependencies and build

```bash
pnpm install --frozen-lockfile
pnpm run build
```

### Run checks

```bash
# Unit tests
pnpm exec vitest run

# Webview type-check
pnpm exec tsc -p tsconfig.webview.json

# Extension type-check
pnpm exec tsc -p tsconfig.extension.json --noEmit

# Full test script (includes Playwright tests)
pnpm test
```

### Launch the extension locally

1. Open this repository in VS Code.
2. Open **Run and Debug**.
3. Select the extension launch configuration and press **F5**.
4. Use the new Extension Development Host window to exercise Axiom.

For the existing helper scripts and debugging details, see [HOW-TO-RUN.md](./HOW-TO-RUN.md). Some of that document still uses the previous OpenCode name and is being cleaned up as the migration proceeds.

## Project layout

| Path | Purpose |
| --- | --- |
| `src/extension.ts` | Extension entry point and VS Code integration |
| `src/OpenCodeViewProvider.ts` | Webview messaging, task worktrees, inspection, and quality-gate execution |
| `src/webview/App.tsx` | Main project-building workspace and task flow |
| `src/webview/components/WorktreeReviewPanel.tsx` | Task diff, acceptance criteria, checks, and selective integration UI |
| `src/webview/components/ProjectMemoryPanel.tsx` | Project memory management UI |
| `src/shared/axiomRuntime.ts` | Task planning and runtime data contracts |
| `src/shared/axiomWorkflow.ts` | Shared planning, review, quality-gate, memory-retrieval, and outcome helpers |
| `src/shared/axiomWorkflow.test.ts` | Workflow helper tests |
| `.github/workflows/axiom-ci.yml` | Build, type checks, and unit tests on pushes and pull requests |
| `.github/workflows/release.yml` | Windows packaging and GitHub Release publishing on version tags |

## Release process

A release is built on Windows and includes both an installable VS Code extension and a Windows installer executable.

1. Ensure CI passes on the commit you intend to release.
2. Update the extension version in `package.json` and commit the change.
3. Push a version tag matching `v*` (for example `v0.4.4`) on the release commit.
4. The **Build Axiom Release** workflow builds, type-checks, runs unit tests, packages the VSIX, compiles the Windows installer, and attaches both files to a GitHub Release.
5. Inspect the workflow run and test the downloaded assets before announcing the release.

The workflow can also be run manually from GitHub Actions with a semantic version input. A manual run creates build artifacts but does not publish a GitHub Release unless it was triggered by a tag.

## Current limitations

- Axiom is a VS Code extension, not yet a standalone Electron desktop application. The Windows `.exe` is an installer wrapper for the extension, not a separate IDE.
- Project memories currently use webview-local storage. They are not a shared database, versioned project file, or cross-device sync system.
- Quality-gate checks depend on the commands and dependencies available in the target repository. A passing check is evidence for the checks that ran, not a guarantee that every behavior is correct.
- Preview and screenshot capture are not yet a complete, automatic end-to-end release feature.
- Legacy OpenCode naming and extension identifiers remain in parts of the codebase and packaging metadata.

## Product direction

Axiom is intended to make AI-assisted software building feel like collaborating on a project rather than supervising a code generator: clear goals, scoped work, visible progress, inspectable changes, honest verification, and a useful final handoff.

See [AXIOM_PRODUCT_DIRECTION.md](./AXIOM_PRODUCT_DIRECTION.md) and [docs/AXIOM_PRODUCT_WORKFLOWS.md](./docs/AXIOM_PRODUCT_WORKFLOWS.md) for more detail.

## Contributing

Before changing infrastructure, trace how it is used and preserve working paths until replacements are tested. Keep task scopes explicit, include acceptance criteria for user-visible behavior, and prefer verifiable outcomes over claims in agent summaries.
