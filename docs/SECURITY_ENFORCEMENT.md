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

The initial policy is least-privilege for operations not yet connected to the evaluator: outbound network requests are denied; shell execution, MCP activation/probes, Git push, deployment publishing and plugin execution require approval. Safe project reads are allowed and project file writes require approval. Privileged actions cannot be changed to unconditional allow by this policy schema. Policy changes themselves require native main-process confirmation and are recorded in the security audit.

The filesystem IPC authorization path now combines its existing path/symlink checks with the persisted workspace policy. Terminal execution, MCP integration activation and the explicit MCP worker-tool probe also consult the persisted policy and write approval/denial outcomes to the audit log. Either layer can deny access; a corrupt, oversized, symlinked or workspace-mismatched policy fails closed. The preload exposes read/update methods only through main-process IPC. The policy evaluator is not yet wired to every MCP tool call inside the model runtime, runtime or browser subresource network request, Git operation, deployment provider call or plugin execution. Those paths remain governed only by their existing individual controls until each integration is implemented and tested.

## Credentials

The generic renderer-accessible secure-storage get/set/remove bridge has been removed. Credentials are handled through provider-specific main-process APIs. Saving or removing GitHub/Supabase credentials, saving MCP credentials, and saving remote worker host credentials require native confirmation. OmniRoute endpoint/API-key changes, connection tests, runtime installation, process startup and external dashboard opening also require native confirmation. Secret values are not included in approval text or audit resources.

## Remote execution and repository access

Submitting or retrying a remote worker task now requires native confirmation. The confirmation identifies the configured Worker Host and repository and displays a bounded, secret-redacted task instruction. Remote repository clone and interrupted-clone retry also require confirmation showing the repository and branch. Git push and recovered-commit push continue to require separate native approval. Remote worker credentials are stored through the main-process secure store and are never returned to the renderer.

## Outbound network and runtime tool enforcement

Workspace policy now includes an exact-host HTTPS allowlist (up to 100 hostnames). Wildcards, URL paths, IP literals and localhost entries are rejected. The user-facing Security and Permissions panel edits the allowlist and policy decisions; policy changes are revision-checked, require native confirmation and are audited.

The isolated browser installs a main-process `webRequest.onBeforeRequest` gate for HTTP(S), WebSocket and secure WebSocket requests. The explicitly approved top-level origin is allowed for that session; additional HTTPS subresource hosts must be on the workspace allowlist. Unlisted subresource requests are blocked and audited rather than opening an uncontrolled prompt for every image/script. Cross-origin top-level navigation still requires native approval; page-initiated navigation and cross-origin redirects remain blocked.

OpenCode runtime configuration now receives ordered V2 `permissions` rules derived from the persisted workspace policy:
- shell and subagent execution require approval (or are denied by policy);
- file edits require approval and sensitive credential paths are denied;
- webfetch/websearch follow the network policy, with exact allowlisted HTTPS hosts permitted for webfetch;
- configured MCP tool actions and MCP resource access require approval or are denied;
- Git push shell commands receive their own policy rule.
Remote MCP endpoints and external OmniRoute endpoints are checked at runtime startup. Remote Worker Host calls and remote Git clone/push operations are checked against the network policy before native approval and execution. The OpenCode runtime receives an authenticated loopback HTTP CONNECT/forward proxy through `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NODE_USE_ENV_PROXY`; each destination is checked against the current workspace policy, native approval is cached only for the current policy revision, and proxy credentials are never exposed through preload APIs. The proxy binds only to IPv4 loopback, requires a per-runtime random Basic-auth token, resolves DNS before connecting, pins the selected address, inspects TLS ClientHello SNI and requires it to match the authorized CONNECT hostname, rejects Encrypted ClientHello, and rejects private, loopback, link-local, reserved and non-global DNS results. It is stopped with the runtime and is inherited by managed child processes that honor the standard proxy environment.

This is not an OS-wide outbound firewall. Clients that ignore standard proxy environment variables, raw socket traffic, UDP/QUIC, and commands or local MCP servers that deliberately clear proxy variables or connect directly can bypass the proxy. The proxy deliberately rejects private/reserved destinations even after approval; local loopback destinations bypass it through the explicit `NO_PROXY` list. The proxy does not inspect encrypted request paths after CONNECT. It improves mediation for compliant HTTP(S) clients, but is not a substitute for an OS firewall or per-process network sandbox.

## Privileged operation audit

Audit events are appended to `security-audit.jsonl` with monotonically increasing sequence numbers, previous-event hashes and HMAC-SHA256 event hashes. The HMAC key and current sequence/hash head are stored through Electron OS-backed encrypted storage and never exposed to the renderer. Each append is flushed before the protected head is advanced. Startup/list/append verification checks the entire retained chain and its protected head; event edits, insertions, reordering, middle deletion, tail truncation, missing files, malformed records and anchor mismatches fail closed.

Legacy schema-v1 audit entries are migrated into the new chain and marked `legacyUnverified`; their pre-migration authenticity cannot be proven retroactively. The Security and Permissions panel displays the latest events and runs chain verification. The renderer can request recent events and verification status through the read-only preload security API.

The active chain is bounded to 4000 events and 5 MiB. Automatic truncation/rotation is intentionally disabled because deleting chain history would weaken tamper evidence; when the cap is reached, further privileged operations fail closed until an explicit verified archive/retention workflow is implemented. Audit persistence and OS-protected anchor updates are fail-closed: if either fails, the privileged operation is not authorized.

## Remaining security work

- Add OS-level egress enforcement for raw sockets, UDP/QUIC and processes that bypass the authenticated runtime proxy.
- Add an explicit verified audit archive/export and retention workflow before the bounded chain reaches its hard stop.
- Extend policy checks to any future Git, deployment, plugin and credential execution paths not routed through the desktop main process.
- Complete platform-specific filesystem race hardening and independent security review.

The current implementation provides application-level permission gates and an OS-key-protected audit chain for the documented paths. It is not an OS-wide network firewall, not every third-party process is socket-mediated, and no independent security audit is claimed.
