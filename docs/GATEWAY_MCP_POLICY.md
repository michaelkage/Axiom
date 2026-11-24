# Gateway MCP policy enforcement

The companion/PWA gateway supports a deny-by-default tool-call policy for configured MCP servers. Set `AXIOM_MCP_POLICY_JSON` to a JSON object keyed by MCP server ID; each entry must contain an explicit, unique `allowedTools` array.

```json
{
  "playwright": {
    "allowedTools": ["browser_navigate", "browser_snapshot"]
  },
  "github": {
    "allowedTools": ["get_file_contents", "search_code"]
  }
}
```

MCP initialization, discovery, and non-tool-call protocol messages continue to pass through. MCP JSON-RPC `tools/call` messages are checked before forwarding; calls without an explicit allowlist entry are denied. JSON-RPC batches containing tool calls are rejected rather than being allowed to bypass inspection.

The gateway records each decision in an append-only JSONL audit file at `~/.config/axiom/gateway-audit.jsonl` by default. Override the location with `AXIOM_AUDIT_LOG_PATH`. Each record includes a monotonically increasing sequence, timestamp, previous-record hash, and SHA-256 hash. The full chain is verified before each append, and the gateway fails closed if it cannot persist or verify an audit record. Tool arguments and credentials are deliberately excluded from audit records.

This policy is enforced at the gateway boundary only. It does not replace runtime-side tool authorization, operating-system sandboxing, outbound network controls, or project-specific approval requirements. Keep allowlists narrow and review them whenever an MCP server's tool inventory changes.


## Outbound MCP destination policy

Before connecting to an HTTP(S) MCP endpoint, the gateway resolves its hostname and rejects loopback, private, link-local, shared-address, documentation, multicast, reserved, and other non-public addresses. If a deliberately trusted MCP service runs on a private network, add only its exact hostname or IP literal to `AXIOM_MCP_ALLOWED_PRIVATE_HOSTS`, as a comma-separated list. For example, `AXIOM_MCP_ALLOWED_PRIVATE_HOSTS=127.0.0.1,localhost`. Treat this as a privileged exception: it bypasses public-address checks for that exact host.

Redirects are disabled on upstream proxy requests so credentials and authenticated requests are not forwarded to redirect destinations. This protects against redirect-based SSRF and credential leakage.

The DNS check is a preflight guard; it does not pin the resolved address into the subsequent Node fetch connection. Deployments exposed to hostile DNS should additionally enforce egress restrictions at the host/container/network layer or use a transport with connection-time DNS pinning. This gateway check is not a replacement for OS-level egress controls.


## Model-runtime tool execution boundary

The PWA tool registry also checks authorization immediately before invoking a registered handler. Calls marked with `source: "mcp"` or carrying an `integrationId` require an exact integration entry in the `mcpPolicy` object passed in the execution context:

```js
await executeTool(toolName, argumentsObject, {
  source: "mcp",
  integrationId: "github",
  mcpPolicy: {
    github: { allowedTools: ["github_read_issue"] }
  }
});
```

The tool name must match an entry in that integration's `allowedTools` array exactly. Missing policy, missing integration identity, malformed allowlists, and unlisted tools are denied before the handler runs. A caller may additionally provide an asynchronous `authorizeTool` callback; it must return `true` or an object with `allowed: true`. Denials emit a metadata-only `tool.denied` event; arguments are not included. This is an execution-boundary primitive: callers that invoke the registry for MCP-originated tools must preserve the source and integration identity in the execution context.


## Model-runtime policy propagation and approvals

The PWA model runners (Ollama and native inference) pass a shared execution context into the tool registry. MCP tools are registered with their originating server ID; the registry uses that identity rather than trusting an identity supplied by model output. The application supplies `state.settings.mcpPolicy` as the runtime allowlist. Its shape is keyed by the exact configured server ID, and its entries contain the exact registered tool names:

```js
{
  "configured-server-id": {
    "allowedTools": ["mcp_configured_server_id_browser_navigate"]
  }
}
```

The registered name is `mcp_` + the server ID with non-alphanumeric/underscore characters replaced by underscores + `_` + the MCP tool name normalized the same way. Policy is deny-by-default: an absent entry or a name mismatch blocks execution before an approval prompt is shown. Gateway-side `AXIOM_MCP_POLICY_JSON` remains a separate first enforcement layer; configure both layers consistently.

Privileged tools are approved centrally at the registry boundary. A tool explicitly marked `requiresApproval` requires a confirmation callback and a positive decision, even if invoked outside the normal chat loop. The registry also automatically marks common mutation actions as approval-required, including Git commits/pushes/merges, GitHub creates/updates, deployments/releases, plugin install/uninstall/enable/disable/configuration, SQL execution, and command execution. The model runners fail closed when the approval UI is unavailable.

OpenCode worker sessions use the provider's native permission requests. Persistent `always` grants are downgraded to one-time approval for `bash`, `edit`, `external_directory`, `task`, `webfetch`, `websearch`, `mcp`, and `plugin` permissions. Read-oriented permissions can retain a persistent grant. Permission decisions are logged without recording command text, file contents, or request metadata that could contain secrets.


## User-facing runtime policy editor

The PWA MCP screen exposes an individual allowlist checkbox for every discovered tool on each configured server. The selected set is persisted in `state.settings.mcpPolicy` using the exact server ID and normalized registered tool name. A newly discovered tool is denied until the user explicitly enables it. Revoking a tool removes it from the runtime allowlist immediately; "Revoke all tools" clears that server's list. This setting is stored with the PWA's normal local workspace settings and is not a replacement for the gateway's independent `AXIOM_MCP_POLICY_JSON` policy. Both layers must be configured consistently.

## OpenCode worker permission audit

Before an OpenCode worker permission response is sent, the webview appends a metadata-only record to `axiom.worker-security-audit.v1` in its local storage. Records contain sequence, timestamp, permission category, requested/effective decision, session ID, previous hash, and SHA-256 hash. The chain is verified before every append and after persistence. If WebCrypto is unavailable, storage fails, or verification detects a modified/truncated/reordered record, Axiom rejects the pending worker operation instead of granting it.

The worker audit currently provides local, restart-persistent tamper-evidence, not hardware-backed or remote immutability. An attacker with write access to the same webview storage can replace the entire chain and recompute hashes. Production deployments requiring adversarial tamper resistance must move the audit anchor to the privileged desktop host (or a remote append-only service) and protect the signing key outside renderer storage. Gateway MCP audit records remain separately enforced and stored by the gateway.
