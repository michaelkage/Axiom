# Desktop security enforcement

## Main-process trust boundary

Renderer requests are accepted only from the current trusted Axiom `BrowserWindow`. Privileged actions are approved by Electron's native main-process dialog; a renderer-provided `approved` field is never consulted.

## Filesystem policy

The desktop file IPC routes use `desktop/security-enforcement.cjs` before reaching the filesystem adapter:

- Reads are restricted to safe workspace-relative paths.
- Absolute paths, traversal, symlinked path components and sensitive path segments are denied.
- `.git`, `node_modules`, `.axiom`, build output, environment files and common private-key filenames are excluded.
- Every renderer-requested project file write requires native confirmation.
- File reads use `O_NOFOLLOW` where the platform supports it.
- File writes use an exclusive temporary file, flush it, and atomically rename it into place rather than truncating the destination in place.

The file adapter retains its own path validation. IPC policy is an additional boundary, not a replacement for filesystem checks.

## Persisted workspace policy

Each selected workspace has a versioned policy record under Axiom user data, keyed by a SHA-256 identity derived from the canonical workspace path. The record includes its schema version, workspace identity, monotonically increasing revision and update timestamp. Policy writes use an exclusive temporary file, file flush, atomic rename and directory flush where supported. A revision supplied by the caller is checked before a write so stale settings cannot silently overwrite a newer policy.

The initial policy is least-privilege for operations not yet connected to the evaluator: shell execution, outbound network requests and MCP invocation are denied; Git push, deployment publishing and plugin execution require approval. Safe project reads are allowed and project file writes require approval. Privileged actions cannot be changed to unconditional allow by this policy schema. Policy changes themselves require native main-process confirmation and are recorded in the security audit.

The filesystem IPC authorization path now combines its existing path/symlink checks with the persisted workspace policy. Either layer can deny access; a corrupt, oversized, symlinked or workspace-mismatched policy fails closed. The preload exposes read/update methods only through main-process IPC. The policy evaluator is intentionally not yet wired to all shell, MCP, runtime network, Git, deployment and plugin execution producers; those producers remain governed only by their existing individual controls until each integration is implemented and tested.

## Credentials

The generic renderer-accessible secure-storage get/set/remove bridge has been removed. Credentials are handled through provider-specific main-process APIs. Saving or removing GitHub/Supabase credentials, saving MCP credentials, and saving remote worker host credentials require native confirmation. OmniRoute endpoint/API-key changes, connection tests, runtime installation, process startup and external dashboard opening also require native confirmation. Secret values are not included in approval text or audit resources.

## Remote execution and repository access

Submitting or retrying a remote worker task now requires native confirmation. The confirmation identifies the configured Worker Host and repository and displays a bounded, secret-redacted task instruction. Remote repository clone and interrupted-clone retry also require confirmation showing the repository and branch. Git push and recovered-commit push continue to require separate native approval. Remote worker credentials are stored through the main-process secure store and are never returned to the renderer.

## Browser network actions

Opening an external browser origin and navigating to a different origin require native approval. Page-initiated top-level navigations and cross-origin redirects are blocked; navigation must be requested through Axiom's approved main-process control. The browser remains isolated from the normal browser profile, denies permissions and downloads, and records network/console diagnostics.

This is not a complete outbound network firewall. Third-party subresource requests made by an approved website are not yet governed by a per-host allowlist. Runtime, MCP and arbitrary shell network traffic still require broader centralized policy enforcement.

## Privileged operation audit

Native approval decisions and filesystem policy decisions are written to `security-audit.jsonl` in Axiom user data. Events contain a timestamp, action, decision, bounded reason, project identifier, bounded/redacted resource and actor. The log is size-bounded and rotates to a bounded recent event window. The renderer can request the latest 200 events through `window.axiomDesktop.security.audit()`.

Audit persistence is fail-closed for privileged operations: if the decision cannot be recorded, the operation is not authorized.

## Remaining security work

- Apply a single project policy evaluator to all worker process creation, MCP tool calls, network clients, deployment provider calls, Git operations and credential consumers.
- Enforce outbound host allowlists for runtime and browser subresource traffic.
- Add a user-facing policy editor; versioned project-scoped persistence and filesystem IPC enforcement are now present.
- Add tamper-evident audit chaining and retention controls.
- Complete platform-specific filesystem race hardening and independent security review.

The current implementation is a stronger desktop enforcement layer, not a claim that every Axiom execution path is already mediated or that the application has undergone an independent security audit.
