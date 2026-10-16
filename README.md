# Axiom

**Build software by describing the outcome, not by starting with a pile of files.**

Axiom is a standalone desktop app for AI-first project building. Describe the feature or outcome you want, let Axiom plan the work, then review scoped changes, diffs, acceptance criteria, and actual verification results. The goal is a project workspace, not another IDE plugin that requires an editor to exist first.

## Download Axiom

**Windows x64:** open the [Axiom Releases page](https://github.com/michaelkage/Axiom/releases) and download `Axiom-Setup-<version>-x64.exe`.

The installer installs the standalone Axiom desktop application, including its desktop shell and local OpenCode runtime. It does **not** install a VS Code extension. Launch Axiom from the Start menu or desktop shortcut, choose a project folder, and connect/configure your model provider in the app. Use **File → Switch Project** (Ctrl+O) to change folders without manually restarting. If the runtime fails to start, Axiom offers a retry and records diagnostics in its application user-data folder; **Help → Open Axiom Runtime Log** opens that log.

If the Releases page does not contain a Windows installer yet, a release has not been published. CI artifacts are not the same as published release assets, because apparently one download location was too straightforward.

## End-user system requirements

- **Operating system:** Windows 10 or Windows 11, 64-bit. The current installer workflow targets Windows x64 only.
- **AI provider:** internet access and valid provider credentials for hosted models, or a separately configured local model provider. Model access may incur provider charges.
- **Project tools:** Axiom can open a folder without Git, but Git is needed for worktree-based task isolation and some change-review workflows.
- **Storage:** keep enough free disk space for the app, its runtime, project dependencies, and any model/provider tools you use. The installer is large because it bundles the desktop runtime.

Axiom does not require VS Code to be installed. Developer tooling such as Node.js and pnpm is required only when building Axiom from source.

## Troubleshooting

See [Desktop troubleshooting](./docs/DESKTOP_TROUBLESHOOTING.md) for startup recovery, provider setup, project access, runtime logs, and known limitations.

## What Axiom does

- **Outcome-first building:** describe the result you want in plain language.
- **Adaptive planning:** break larger requests into scoped tasks, acceptance criteria, dependencies, and parallel work where safe.
- **Reviewable agent work:** isolate task changes in Git worktrees where supported and inspect diffs before integrating.
- **Evidence-based quality gates:** run relevant checks and show actual command output instead of treating an agent's “done” message as proof.
- **Bounded repair:** send real failed-check output back for a limited correction attempt.
- **Selective integration:** review changed files and integrate selected work without blindly replacing unrelated edits.
- **Project memory:** save project conventions, architecture notes, decisions, and fixes. Project context and verification history are stored locally in Axiom's per-user application data, outside the repository, and are not synced between devices.
- **Native file workspace:** browse, inspect, edit, and save project files from inside the desktop app. The desktop file bridge rejects path traversal and symbolic links, excludes dependency/build directories, and caps file edits at 1 MiB.
- **Outcome-centered handoff:** track completed and blocked tasks, outstanding requirements, and verification evidence.

Features are actively evolving. Some legacy internal modules still use OpenCode names because the application is built on OpenCode's runtime and client libraries. The product you install is Axiom.

## Quick start

1. Install and launch Axiom.
2. Choose the folder for the project you want to work on.
3. Configure a supported model provider in the app. Provider access and model API credentials may be required.
4. Enter a concrete request, for example: “Add CSV export to the reports page, include tests, and summarize the files changed.”
5. Review the proposed plan, task scopes, and acceptance criteria.
6. Inspect each task's changed files, diff, and quality-gate output.
7. Integrate the changes you want. A successful agent response is not the same thing as a passed quality gate.

Start with a small change while you confirm your model provider and local development toolchain are configured.

## How the desktop app works

Axiom is an Electron desktop application. It opens a project folder and starts a local OpenCode runtime for that workspace. The runtime listens on a loopback interface, not a public network interface. The installer bundles the desktop app and the OpenCode CLI runtime so a separate VS Code installation is not required.

Axiom works on files in the project folder you select. Review generated changes carefully and keep backups or version control for important projects. Agent permissions and tool availability depend on the runtime and model configuration.

### Optional OmniRoute integration

On the first-run welcome screen, Axiom can connect to an existing OmniRoute-compatible API or optionally install and manage a local OmniRoute instance. OmniRoute's default local API is `http://127.0.0.1:20128/v1`; the dashboard is normally available at `http://127.0.0.1:20128`.

- **Connect existing router:** set the OpenAI-compatible API base URL and, if required, its API key.
- **Install:** the explicit Install button runs `npm install --global omniroute`. It does not silently install software during Axiom setup.
- **Attach to Axiom:** enabling this option adds the selected router model to the OpenCode runtime configuration on the next Axiom launch. The API key is encrypted with Electron's OS-backed secure storage; Axiom refuses to persist it if secure storage is unavailable.
- **Start with Axiom:** optional and only for the local default OmniRoute service. Axiom only stops the router process it started itself, never a separately running router.
- **No router required:** direct OpenCode providers, local model servers, custom endpoints, and existing provider credentials remain available without OmniRoute.

The OmniRoute installer is maintained by the [OmniRoute project](https://github.com/diegosouzapw/OmniRoute). Review its install requirements and provider terms before connecting accounts or enabling models.
  
## Development setup

### Requirements

- Node.js 20
- pnpm 10, matching the version pinned in the root `package.json`
- npm for the Electron desktop packaging project
- Git for worktree-based task isolation and change review

### Install and build the UI

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run build:webview
```

The standalone desktop UI is emitted to `out/src/webview/standalone.html` and its associated assets.

### Run checks

```bash
pnpm exec vitest run
pnpm exec tsc -p tsconfig.webview.json
pnpm exec tsc -p tsconfig.extension.json --noEmit
node --check desktop/main.cjs
```

The full `pnpm test` script also runs Playwright browser tests. Those tests may need browser/runtime dependencies installed for your environment.

### Run the desktop app in development

Build the UI first, then install desktop dependencies and launch Electron:

```bash
pnpm install --frozen-lockfile
pnpm run build:webview
cd desktop
npm install
npm start
```

To create the Windows installer locally, from the repository root:

```bash
pnpm run build:webview
cd desktop
npm install
npm run dist
```

The installer is emitted to `desktop/release/`. The release workflow performs the same steps on a Windows runner and attaches the installer to a tagged GitHub Release.

## Project layout

| Path | Purpose |
| --- | --- |
| `desktop/main.cjs` | Electron main process, project selection, and local runtime lifecycle |
| `desktop/package.json` | Desktop dependencies and Windows installer configuration |
| `src/webview/standalone.html` | Standalone desktop UI entry point |
| `src/webview/App.tsx` | Main project-building workspace and task flow |
| `src/webview/components/WorktreeReviewPanel.tsx` | Task diff, acceptance criteria, checks, and selective integration UI |
| `src/webview/components/ProjectMemoryPanel.tsx` | Project memory management UI |
| `src/OpenCodeViewProvider.ts` | Legacy VS Code host integration and task worktree/quality-gate handlers |
| `src/shared/axiomRuntime.ts` | Task planning and runtime data contracts |
| `src/shared/axiomWorkflow.ts` | Shared planning, review, quality-gate, memory-retrieval, and outcome helpers |
| `src/shared/axiomWorkflow.test.ts` | Workflow helper tests |
| `.github/workflows/axiom-ci.yml` | Build, type checks, and unit tests on pushes and pull requests |
| `.github/workflows/release.yml` | Standalone Windows installer packaging and release publishing |

## Release process

1. Ensure CI passes on the intended release commit.
2. Set the version in both the root `package.json` and `desktop/package.json`.
3. Push a tag matching `v*` (for example `v0.4.4`) to that commit.
4. The **Build Axiom Desktop Release** workflow builds the standalone UI, installs desktop packaging dependencies, packages the app and runtime, and creates `Axiom-Setup-<version>-x64.exe`.
5. The workflow creates a SHA-256 checksum file alongside the installer and attaches both to the GitHub Release. Verify the downloaded installer against the `.sha256` asset before running it. In PowerShell, from the folder containing the installer, run:

```powershell
$installer = Get-ChildItem .\Axiom-Setup-*-x64.exe | Select-Object -First 1
Get-FileHash $installer.FullName -Algorithm SHA256
Get-Content "$($installer.FullName).sha256"
```

Confirm the reported hash matches the hash in the checksum file. Inspect the workflow run and test the downloaded installer before announcing the release. Publishing a build does not mean its interactive installation/startup has been smoke-tested.

A manual workflow run builds an artifact but does not publish a GitHub Release unless triggered by a tag.

## Preview status

The Windows installer can be built by CI, but interactive installation, first launch, provider setup, project switching, and shutdown have **not yet been manually smoke-tested on a Windows machine**. That validation is intentionally deferred. Treat the current build as a preview until those checks are completed; a successful packaging workflow is not proof that the full desktop experience works on every machine.

## Current limitations

- The current official packaged installer target is Windows x64. macOS and Linux packages are not yet part of the release workflow.
- Project memories currently use app/webview-local storage. They are not yet a shared database, versioned project file, or cross-device sync system.
- Quality-gate checks depend on commands and dependencies available in the target repository. Passing checks are evidence for the checks that ran, not a guarantee that every behavior is correct.
- Preview and screenshot capture are not yet a complete, automatic end-to-end workflow.
- Some internal modules and legacy development configurations still retain VS Code/OpenCode naming while the standalone desktop migration continues.

## Product direction

Axiom is intended to make AI-assisted software building feel like collaborating on a project rather than supervising a code generator: clear goals, scoped work, visible progress, inspectable changes, honest verification, and a useful final handoff.

See [AXIOM_PRODUCT_DIRECTION.md](./AXIOM_PRODUCT_DIRECTION.md) and [docs/AXIOM_PRODUCT_WORKFLOWS.md](./docs/AXIOM_PRODUCT_WORKFLOWS.md) for product and workflow details.

## Contributing

Trace how existing infrastructure is used before replacing it. Keep task scopes explicit, define acceptance criteria for user-visible behavior, and prefer verifiable outcomes over claims in agent summaries. Changes to desktop startup or runtime lifecycle should include a smoke test on the target operating system.
