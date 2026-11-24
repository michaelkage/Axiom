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
