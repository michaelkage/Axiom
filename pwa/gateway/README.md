# Axiom local gateway

The gateway keeps Ollama, GitHub, Supabase, and MCP upstream access behind one authenticated local process. Browser clients never receive configured GitHub PATs, Supabase publishable keys, or MCP bearer tokens.

## Run

Node.js 20+ is required.

```bash
cd pwa
AXIOM_GATEWAY_TOKEN="$(openssl rand -hex 32)" \
OLLAMA_BASE_URL="http://127.0.0.1:11434" \
AXIOM_ALLOWED_ORIGINS="https://your-pwa.example" \
MCP_SERVERS_JSON='{"filesystem":{"url":"http://127.0.0.1:3001/mcp","token":"SERVER_SIDE_MCP_TOKEN"}}' \
GITHUB_TOKEN="github_pat_..." \
GITHUB_REPOSITORY="michaelkage/Axiom" \
SUPABASE_URL="https://your-project.supabase.co" \
SUPABASE_PUBLISHABLE_KEY="sb_publishable_..." \
npm run gateway
```

By default the gateway binds to `127.0.0.1:8787`. Keep that default for a same-device development setup. To expose it on a LAN, explicitly set `AXIOM_GATEWAY_HOST=0.0.0.0`, use HTTPS at a trusted reverse proxy, configure exact allowed origins, and firewall the port.

## Security model

- Every protected route requires either the bootstrap bearer token or a registered ephemeral session token. Both are compared in constant time.
- POST /session/register requires the bootstrap token and registers a random client session token for at most 12 hours. Sessions are held in memory and are cleared when the gateway restarts.
- Token comparisons use constant-time comparison.
- Browser origins are checked against an exact allowlist. No wildcard origin or credentialed cookie support.
- Ollama is a fixed upstream; only known API endpoints and GET/POST methods are allowed.
- MCP servers are selected by ID from `MCP_SERVERS_JSON`; browser input cannot supply arbitrary upstream URLs. Upstream bearer tokens remain in the gateway process.
- Request bodies are capped at 2 MiB. Responses are streamed and marked no-store.
- GitHub access is restricted to GET/PUT content operations in the single configured `GITHUB_REPOSITORY`; the PAT stays in the gateway process.
- Supabase REST requests use the gateway-held publishable key. Secret and service-role keys are rejected; database permissions and RLS remain the actual authorization boundary.
- MCP requests can only target IDs in `MCP_SERVERS_JSON`; gateway-managed connections use Streamable HTTP. Legacy SSE remains direct-browser only and cannot carry gateway authorization.
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
| `GITHUB_TOKEN` | optional | Least-privilege GitHub PAT, gateway only |
| `GITHUB_REPOSITORY` | optional | Exact `owner/name` allowlist for GitHub content API |
| `SUPABASE_URL` | optional | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | optional | Publishable key or legacy anon JWT only, never service-role |

Run gateway tests with `npm test`.
