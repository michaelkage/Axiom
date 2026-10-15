# Standalone Axiom Runtime: Implementation Contract

This document is the execution contract for making Axiom a standalone AI-first coding app. Electron is the application host. The existing webview and OpenCode SDK remain reusable implementation components, not product identity. VS Code is not required to launch, use, or package Axiom.

## Current baseline

- Electron owns project selection, OpenCode server startup/shutdown, application menus, and the window lifecycle.
- The renderer uses SolidJS and connects to the local OpenCode server.
- The desktop preload currently provides a narrow message bridge; task worktree inspection, quality gates, and safe integration are handled by the Electron main process.
- The repository still contains VS Code-specific build configuration and contribution metadata. These are migration references until equivalent standalone functionality is covered.

## Architecture boundaries

1. **Renderer:** conversation, plans, worker activity, topic-based change feed, diffs, diagnostics, previews, and approval UI. No direct Node.js access.
2. **Desktop host:** secure IPC, dialogs, window lifecycle, filesystem and terminal adapters, runtime process lifecycle, and OS integration.
3. **Project state:** project-specific context and change history persisted under Electron's user-data directory. Never write Axiom metadata into a user's repository unless explicitly requested.
4. **Agent runtime:** OpenCode sessions and events behind a replaceable runtime adapter. Planning, worker execution, cancellation, and event normalization must be testable without UI components.
5. **Provider routing:** OmniRoute/provider configuration is an adapter, not a hard dependency for local OpenCode execution.
6. **Verification:** command exit codes and captured test/build output are the evidence of success. Model-authored summaries are not verification evidence.
7. **Packaging:** the desktop package bundles the runtime and renderer output. Runtime services bind to loopback; renderer Node integration remains disabled.

## Implementation sequence and acceptance criteria

### 1. Desktop foundation
- Provide explicit preload methods for project bootstrap, project context, change history, and project selection.
- Validate renderer identity on privileged IPC handlers.
- Persist metadata atomically outside the repository and bound its size.
- Test persistence, validation, and history limits with Node's built-in test runner.

### 2. Conversation-first workspace
- Make the primary entry point a goal composer and project conversation.
- Store user-approved project context across restarts.
- Show each implementation as a change topic with files, rationale, checks, and a detail-on-demand diff.
- Keep editor, terminal, Git, and logs available as power tools.

### 3. Runtime and orchestration
- Define a runtime adapter interface for planning, session creation, event subscription, cancellation, and session lookup.
- Normalize provider/session events into a stable Axiom event schema.
- Persist run/task/worker state and recover interrupted runs as interrupted, never falsely completed.
- Isolate parallel work in Git worktrees; validate repository identity and changed paths before integration.

### 4. Verification and bounded repair
- Run applicable project checks with explicit timeouts and captured stdout/stderr.
- Display each check as passed, failed, skipped, or blocked with command and exit code.
- Permit a bounded number of repair attempts and require re-verification after every repair.
- Never mark a run verified if no applicable project-level check ran, unless the UI explicitly labels it as not verified.

### 5. Provider routing and diagnostics
- Surface OmniRoute connectivity, configured model aliases, provider errors, and routing diagnostics.
- Keep local OpenCode operation usable when OmniRoute is unavailable.
- Display diagnostics with source, severity, code, and location where available; make automated repairs reviewable.

### 6. Migration and release
- Audit every VS Code API use and move required capabilities behind desktop adapters.
- Keep extension build/test paths until their replacement behavior is covered by standalone tests.
- Add clean-install, launch, project-switch, runtime-shutdown, upgrade, and packaged-runtime smoke tests.
- Publish signed installers and release notes for each supported operating system; do not advertise an OS as supported until its package is built and smoke-tested.

## Security and reliability invariants

- Electron renderer has `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`.
- IPC handlers validate the sender and validate input types/limits.
- The runtime binds to `127.0.0.1`, not a public interface.
- No arbitrary shell command IPC is exposed to renderer code.
- Project metadata writes are atomic and bounded.
- Cancellation and shutdown are explicit states; worker completion requires runtime evidence.
- Changes are integrated only after review and verification, with conflicts and dirty destination files blocking integration.
