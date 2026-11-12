# Axiom local gateway

The gateway keeps Ollama, GitHub, Supabase, and MCP upstream access behind one authenticated local process. It also generates and securely stores its pairing credential on first run. Browser clients never receive configured GitHub PATs, Supabase publishable keys, or MCP bearer tokens.

## 1. Gateway pairing and authentication

You do not need to create or export `AXIOM_GATEWAY_TOKEN`. On first startup, the gateway generates a cryptographically random 256-bit token and stores it in `~/.config/axiom/gateway-token` with owner-only file permissions.

**Android on the same phone:** use the one-command Termux bootstrap in [TERMUX_SETUP.md](../TERMUX_SETUP.md). It sets `AXIOM_GATEWAY_SILENT_TOKEN=1`, so the pairing secret is not written to the gateway log, then hands it directly to the installed Axiom app through an explicit Android package intent. Axiom validates the credential with the gateway, immediately clears it from the launch intent, encrypts it with Android Keystore, and manages renewable 12-hour sessions. No token screen, copying, or pasting is involved.

**Gateway on another machine:** normal first startup prints the generated token once. Use the advanced remote-pairing section in Android Settings and a trusted HTTPS gateway URL. The app encrypts the bootstrap credential with Android Keystore. Browser-only PWA mode can enter the bearer token in Settings; it stays in memory and is cleared on reload.

The pairing token protects gateway routes. It is not a GitHub or Supabase credential. Do not commit the token file or share its contents.

If the token is lost or compromised, stop the gateway, replace `~/.config/axiom/gateway-token` with a newly generated 64-character hex value, restart the gateway, and pair Axiom again.

## 2. Get the GitHub token

1. Open [GitHub fine-grained personal access tokens](https://github.com/settings/personal-access-tokens/new).
2. Create a token restricted to only the repository Axiom should access.
3. Grant Repository permissions: Contents read/write if Axiom should edit files, or Contents read for read-only use. Metadata read is required.
4. Set an expiry, generate the token, and copy it immediately.
5. Open Axiom Settings → Provider credentials, paste the PAT into the GitHub field, enter the exact `owner/repo`, and save. Do not paste it into chat or commit it.

Axiom stores the token and repository in `~/.config/axiom/provider-credentials.json` with owner-only permissions. The gateway restricts GitHub content operations to this repository. Environment variables remain supported for headless deployments and override the saved file.

## 3. Get the Supabase URL and publishable key

1. Open the [Supabase Dashboard](https://supabase.com/dashboard) and select your project.
2. Open the project's **Connect** dialog to copy the Project URL and publishable key, or use **Settings → API Keys**.
3. Open Axiom Settings → Provider credentials, enter the Project URL and `sb_publishable_...` key, then save. The app does not receive the key back.

A legacy `anon` key is also supported for compatibility. Never use `sb_secret_...` or `service_role`. Publishable keys are low-privilege by design; table grants and Row Level Security policies still control data access. Tables must also be exposed through the Data API. Supabase SQL/schema tools require a project-owned, permission-controlled `exec_sql` RPC. Do not expose an unrestricted SQL function.

## 4. Optional MCP server credentials

If an MCP server requires a bearer token, place it in that server's `token` field inside `MCP_SERVERS_JSON` on the gateway host. The app selects the configured server by ID; the upstream token remains server-side.

## 5. Configure credentials from Axiom

After pairing the gateway, open **Settings → Provider credentials**:

- GitHub: enter a fine-grained PAT and the exact `owner/repo`.
- Supabase: enter the project URL and publishable key (or legacy anon key).
- Use the Remove controls to delete saved credentials.

The authenticated `GET /provider-config` endpoint returns only configured flags and non-secret identifiers. `PUT /provider-config` updates credentials on the gateway host. Secrets are stored atomically in `~/.config/axiom/provider-credentials.json`; the directory is mode `0700` and the file is mode `0600`. Secrets are never returned to the client or written to browser storage. Environment variables take precedence over the saved file.
## 6. Run

Node.js 20+ is required. From the `pwa` directory, optional environment variables can still be used for headless deployments. For the Android Termux setup, enter GitHub and Supabase credentials in Axiom Settings:

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
| `AXIOM_GATEWAY_SILENT_TOKEN` | `0` | Set to `1` in managed bootstrap environments to suppress first-run secret output |
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

Axiom's Android APK also includes a separate native llama.cpp inference engine for on-device GGUF models. That engine does not require this gateway, Termux, or Ollama. The Termux bridge remains an optional compatibility path for Ollama-hosted models and gateway-managed integrations.

## Desktop and mobile companion approvals

The gateway exposes a deliberately narrow companion protocol for pairing a second Axiom client and requesting human approval. It reuses the gateway's authenticated transport; it does not create a second listener or expose an arbitrary desktop control socket.

- `POST /companion/pairing` requires an authenticated desktop-side gateway session and returns an eight-digit, single-use code valid for 90 seconds.
- `POST /companion/pairing/claim` exchanges that code for a random 256-bit companion credential. Claims are rate-limited to 10 attempts per source IP per minute.
- Companion credentials expire after 12 hours and are restricted to the companion approval endpoints. They cannot proxy Ollama, GitHub, Supabase, MCP, provider configuration, or create further pairing codes.
- `POST /companion/approvals` accepts a bounded approval request from a paired device. Capabilities are allowlisted (`shell.execute`, `workspace.write`, `git.integrate`, `tool.execute`); summaries, commands and resources have strict length limits.
- `GET /companion/approvals` lists requests belonging to the authenticated desktop session. `POST /companion/approvals/{id}/decision` records an explicit `approved` or `denied` decision. Requests expire after 10 minutes.
- `GET /companion/approvals/{id}` lets only the requesting paired device read its decision. `DELETE /companion/pairs/{pairId}` revokes the paired credential and removes its outstanding requests.

Pairing and approval state is held in gateway memory and is intentionally cleared on gateway restart. An approval decision is a state record only: it does not execute a shell command, write a file, integrate a worktree, or grant a capability by itself. A client must still enforce the decision at the point where the protected action is performed. Use HTTPS for remote gateways; pairing codes are short-lived, not a substitute for transport encryption.
