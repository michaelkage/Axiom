# Axiom local gateway

The gateway keeps Ollama and MCP upstream access behind one authenticated local process. Browser clients never receive configured MCP bearer tokens.

## Run

Node.js 20+ is required.

```bash
cd pwa
AXIOM_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
OLLAMA_BASE_URL="http://127.0.0.1:11434" \
AXIOM_ALLOWED_ORIGINS="https://your-pwa.example" \
MCP_SERVERS_JSON='{"filesystem":{"url":"http://127.0.0.1:3001/mcp","token":"SERVER_SIDE_MCP_TOKEN"}}' \
npm run gateway
```

By default the gateway binds to `127.0.0.1:8787`. Keep that default for a same-device development setup. To expose it on a LAN, explicitly set `AXIOM_GATEWAY_HOST=0.0.0.0`, use HTTPS at a trusted reverse proxy, configure exact allowed origins, and firewall the port.

## Security model

- Every non-health route requires a random bearer token of at least 32 characters.
- Token comparisons use constant-time comparison.
- Browser origins are checked against an exact allowlist. No wildcard origin or credentialed cookie support.
- Ollama is a fixed upstream; only known API endpoints and GET/POST methods are allowed.
- MCP servers are selected by ID from `MCP_SERVERS_JSON`; browser input cannot supply arbitrary upstream URLs. Upstream bearer tokens remain in the gateway process.
- Request bodies are capped at 2 MiB. Responses are streamed and marked no-store.
- The gateway does not expose GitHub or Supabase privileged credentials. Keep those integrations disabled until their backend adapter is configured; never place service-role keys in the PWA.
- This gateway is a local trust boundary, not an internet-facing multi-user service. Do not expose it publicly without TLS, network controls, per-user identity, rate limits, and audit logging.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AXIOM_GATEWAY_TOKEN` | required | Random 32+ character client token |
| `AXIOM_GATEWAY_HOST` | `127.0.0.1` | Bind address |
| `AXIOM_GATEWAY_PORT` | `8787` | Listen port |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Fixed Ollama upstream |
| `AXIOM_ALLOWED_ORIGINS` | local Vite origins | Comma-separated exact browser origins |
| `MCP_SERVERS_JSON` | `{}` | Server-side MCP ID-to-URL/token map |

Run gateway tests with `npm test`.
