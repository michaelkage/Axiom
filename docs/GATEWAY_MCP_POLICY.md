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
