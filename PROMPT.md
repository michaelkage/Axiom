Work from the current Axiom product backlog in `TODO.md`. Axiom is a standalone Electron desktop application, not an editor extension.

For each task:
1. Inspect the current implementation and relevant tests before changing code.
2. Write a short implementation plan for non-trivial work and record research only when it informs a real decision.
3. Implement the task in the standalone Electron/renderer architecture. Do not restore extension-host code or editor-specific APIs.
4. Add or update tests for behavior changes.
5. Run the relevant checks: UI build, renderer type-check, unit tests, desktop host tests, and browser tests when applicable.
6. Update `TODO.md` and user documentation to reflect the actual result.
7. Commit changes directly to the active requested branch when authorized.

If blocked, record the concrete reason and the remaining work instead of claiming completion. Never report tests or release publication as successful unless the workflow results confirm it.
