# Axiom local gateway

The gateway keeps Ollama, GitHub, Supabase, and MCP upstream access behind one authenticated local process. It also generates and securely stores its pairing credential on first run. Browser clients never receive configured GitHub PATs, Supabase publishable keys, or MCP bearer tokens.

## 1. Gateway pairing token (automatic)

You no longer need to create or export `AXIOM_GATEWAY_TOKEN`. On first startup, the gateway generates a cryptographically random 256-bit token, stores it in `~/.config/axiom/gateway-token` with owner-only file permissions, and prints it once. Copy it during that first startup and paste it into Axiom's Android **Settings → Secure gateway pairing**. Later starts reuse the saved token without displaying it again.

The Android app encrypts the pairing credential with Android Keystore. The app generates temporary 12-hour session tokens automatically. The pairing token is not a GitHub or Supabase credential.

If the token is lost or compromised, stop the gateway, replace `~/.config/axiom/gateway-token` with a newly generated 64-character hex value, restart the gateway, and pair Axiom again. Do not commit this file or share its contents.

## 2. Get the GitHub token

1. Open [GitHub fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new).
2. Create a token restricted to only the repository Axiom should access.
3. Grant Repository permissions: Contents read/write if Axiom should edit files, or Contents read for read-only use. Metadata read is required.
4. Set an expiry, generate the token, and copy it immediately.
5. Set it as `GITHUB_TOKEN` in the gateway process environment. Do not paste it into Axiom or commit it.

Set `GITHUB_REPOSITORY` to the exact `owner/repo`. Axiom's Repository field must match this value. The gateway restricts GitHub content operations to this repository.

## 3. Get the Supabase URL and publishable key

1. Open the [Supabase Dashboard](https://supabase.com/dashboard) and select your project.
2. Open the project's **Connect** dialog to copy the Project URL and publishable key, or use **Settings → API Keys**.
3. Set the URL as `SUPABASE_URL` and the `sb_publishable_...` key as `SUPABASE_PUBLISHABLE_KEY` in the gateway environment.

A legacy `anon` key is also supported for compatibility. Never use `sb_secret_...` or `service_role`. Publishable keys are low-privilege by design; table grants and Row Level Security policies still control data access. Tables must also be exposed through the Data API. Supabase SQL/schema tools require a project-owned, permission-controlled `exec_sql` RPC. Do not expose an unrestricted SQL function.

## 4. Optional MCP server credentials

If an MCP server requires a bearer token, place it in that server's `token` field inside `MCP_SERVERS_JSON` on the gateway host. The app selects the configured server by ID; the upstream token remains server-side.

## 5. Run

Node.js 20+ is required. From the `pwa` directory, after setting the variables above:

```bash
OLLAMA_BASE_URL="http://127.0.0.1:11434" \
AXIOM_ALLOWED_ORIGINS="https://your-pwa.example" \
GITHUB_TOKEN="github_pat_..." \
GITHUB_REPOSITORY="owner/repo" \
SUPABASE_URL="https://your-project.supabase.co" \
SUPABASE_PUBLISHABLE_KEY="sb_publishable_..." \
npm run gateway
```

By default the gateway binds to `127.0.0.1:8787`. Keep that default for a same-device development setup. To expose it on a LAN, explicitly set `AXIOM_GATEWAY_HOST=0.0.0.0`, use HTTPS at a trusted reverse proxy, configure exact allowed origins, and firewall the port. Do not expose this single-user local trust boundary directly to the public internet.

## Security model

- Every protected route requires either the bootstrap bearer token or a registered ephemeral session token. Both are compared in constant time.
- POST /session/register requires the bootstrap token and registers a random client session token for at most 12 hours. Sessions are held in memory and are cleared when the gateway restarts.
- Browser origins are checked against an exact allowlist. No wildcard origin or credentialed cookie support.
- Ollama is a fixed upstream; only known API endpoints and GET/POST methods are allowed.
- MCP servers are selected by ID from `MCP_SERVERS_JSON`; browser input cannot supply arbitrary upstream URLs. Upstream bearer tokens remain in the gateway process.
- GitHub access is restricted to GET/PUT content operations in the single configured `GITHUB_REPOSITORY`; the PAT stays in the gateway process.
- Supabase REST requests use the gateway-held publishable key. Secret and service-role keys are rejected; database grants and RLS remain the authorization boundary.

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `AXIOM_GATEWAY_TOKEN` | auto-generated | Optional override for the random 32-byte pairing secret; otherwise stored under `~/.config/axiom/` |
| `AXIOM_GATEWAY_HOST` | `127.0.0.1` | Bind address |
| `AXIOM_GATEWAY_PORT` | `8787` | Listen port |
| `OLLAMA_BASE_URL` | `http://127.0.0.1:11434` | Fixed Ollama upstream |
| `AXIOM_ALLOWED_ORIGINS` | local Vite origins | Comma-separated exact browser origins |
| `MCP_SERVERS_JSON` | `{}` | Server-side MCP ID-to-URL/token map |
| `GITHUB_TOKEN` | optional | Least-privilege GitHub fine-grained PAT, gateway only |
| `GITHUB_REPOSITORY` | optional | Exact `owner/name` allowlist for GitHub content API |
| `SUPABASE_URL` | optional | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | optional | Publishable key or legacy anon JWT only, never service-role |

Run gateway tests with `npm test`.


## Connection diagnostics

Authenticated clients can request `GET /diagnostics` with the gateway bearer/session token. The endpoint performs bounded, read-only checks from the gateway host:

- Ollama: `GET /api/tags`
- GitHub: `GET /repos/{GITHUB_REPOSITORY}` using the server-side `GITHUB_TOKEN`
- Supabase: `GET /rest/v1/` using `SUPABASE_PUBLISHABLE_KEY` (PostgREST validates the API key without querying user tables)
- MCP: reports configured server IDs; use the MCP tab's discovery action to verify protocol connectivity

The response reports configuration, reachability, authentication acceptance, HTTP status, and an actionable message. It never returns credential values or upstream response bodies. Provider checks run in parallel with an 8-second timeout and do not read or modify repository files, database rows, or schemas.

## Model library and Hugging Face

The Models tab lists installed models and streams downloads through Ollama's `POST /api/pull` endpoint. Hugging Face search filters for GGUF repositories and installs compatible repositories through Ollama's `hf.co/<owner>/<repo>:<quantization>` model reference. Downloads occur on the machine running Ollama, not in the PWA browser. Verify each model card, license, quantization, and memory requirements before installing.

A standard desktop Ollama daemon is not an Android-native service. On Android, the app can manage an Ollama runtime reachable through the configured gateway, but cannot silently install or run the desktop Ollama binary inside the APK. Fully offline, on-device inference requires a separate Android-native inference engine and is not claimed by this release.
