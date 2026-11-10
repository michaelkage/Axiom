# Axiom Desktop Troubleshooting

This guide is for the standalone Windows desktop application, not the legacy VS Code host integration.

## Axiom does not open or the startup window keeps returning

1. Retry once from the startup error dialog.
2. If the selected project folder is unavailable or has been moved, choose **Choose Another Project** and select an existing folder.
3. Open **Help → Open Axiom Runtime Log** from the app menu when the menu is available. The log is stored under Electron's Axiom application user-data directory at `logs/runtime.log`.
4. If startup still fails, quit Axiom, reinstall from a fresh installer, and try a simple local project folder whose path you can access.
5. Keep the last section of the runtime log and the Axiom version when reporting the issue. Remove API keys, tokens, private paths, and other secrets before sharing logs.

The startup dialog includes recent runtime output when available. A failed startup attempt should not itself modify project files.

## The runtime stops after Axiom opens

Axiom records runtime process errors and exit codes. When the runtime stops unexpectedly, the app offers to restart Axiom or quit. Restarting creates a fresh local runtime connection for the currently selected project.

If it repeatedly stops:

- Check **Help → Open Axiom Runtime Log**.
- Confirm that endpoint-security software has not quarantined Axiom's bundled runtime.
- Check that the project folder is readable and writable by your Windows account.
- Retry with a small local project folder to distinguish a project-specific issue from a general startup issue.

Do not expose the local runtime port to a public network. Axiom starts the runtime on the loopback interface.

## Axiom opens but AI requests fail

The desktop app and local runtime do not automatically provide hosted-model credentials. Open the provider/model settings in Axiom and confirm that:

- A supported provider is selected.
- Required API credentials are configured and valid.
- The selected model is available to that provider/account.
- The machine can reach the provider, or your local provider is already running and configured.

Provider access may incur charges. Never paste credentials into issue reports or logs.

## Project switching and file access

Use **File → Switch Project** (Ctrl+O) to select another folder. Axiom relaunches the local runtime for the newly selected project.

Axiom can open a regular folder without Git, but Git is required for Git worktree-based task isolation. If a task's worktree cannot be created, confirm that Git is installed, available on PATH, and that the selected project is inside a valid Git repository.

Review proposed changes before integrating them. Keep version control or backups for important work.

## Installer and platform support

- The current packaged target is Windows x64. macOS and Linux installers are not currently produced by the release workflow.
- The installer bundles the desktop shell and local OpenCode runtime; VS Code is not required.
- A CI build passing means packaging steps completed, not that installation and first-run behavior have been manually verified on every supported Windows configuration.
- Interactive Windows installation, startup, provider onboarding, project switching, and shutdown smoke tests are intentionally deferred and should be completed before treating a preview build as production-ready.

## Reporting a problem

Include the Axiom version, Windows version, a short reproduction sequence, the visible error, and relevant sanitized runtime-log lines. Do not include API keys, access tokens, private repository credentials, or sensitive project content.
