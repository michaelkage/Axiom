# Axiom — Mobile AI Command Center

A touch-first Progressive Web App built with React, Vite, Tailwind CSS, and Lucide.

## Run locally
```bash
npm ci
npm run dev -- --host 0.0.0.0
```
Open the Vite network URL from Android. Ollama must be reachable from the browser at the configured base URL (default `http://localhost:11434`) and allow the PWA origin through CORS.

## Implemented
- Responsive bottom navigation: Chat, Tools, MCP, Logs
- Ollama model discovery and streamed `/api/generate` responses
- Ollama `/api/chat` tool-calling loop when integrations are registered
- LocalStorage persistence for chats, preferences, endpoints, and settings
- Async JSON-schema tool registry with execution events
- GitHub tools: read files, create files, update files/commits
- Supabase tools: list/describe tables, select rows, and optional project-defined SQL RPC
- MCP Streamable HTTP and legacy SSE; discovered tools are schema-injected and registered for model use
- Collapsible execution traces and installable PWA shell

## Security and transport notes
- Browser storage is not encrypted. Conversations and non-secret preferences are stored locally; GitHub, Supabase, MCP, and gateway credentials are kept in memory only and must be re-entered after reload.
- Use the authenticated gateway for Ollama, GitHub, Supabase, and gateway-managed Streamable HTTP MCP. GitHub PATs, Supabase publishable keys, and MCP bearer tokens remain in the gateway process. Never configure a Supabase service-role/secret key.
- GitHub gateway access is restricted to content reads/writes for one configured repository. SQL execution and remote MCP tools require explicit per-call approval. MCP annotations are supplied by remote servers and are treated as advisory, not as a trusted security boundary.
- Supabase's REST OpenAPI schema is no longer available to anon/publishable-key requests. Table and column discovery therefore uses a project-owned `exec_sql` RPC; the app does not create that function or grant it permissions. Only connect a narrowly permissioned RPC that you have reviewed. Do not implement it as a broadly executable SECURITY DEFINER function.
- Supabase SQL execution is only available if you deliberately provide a permission-controlled `exec_sql` RPC. No generic privileged SQL endpoint is bundled.
- Browser MCP requires server CORS support. Streamable HTTP and legacy SSE are implemented; legacy EventSource cannot attach custom authorization headers, so a same-origin authenticated proxy is recommended for protected production servers.
- Browser-to-Ollama requests require CORS permission. Android localhost routing depends on where Ollama is hosted. HTTPS pages may block plain HTTP connections depending on browser security policy.

## Android installation and release
See [ANDROID_VALIDATION.md](./ANDROID_VALIDATION.md) for Chrome installation, standalone-mode, offline, keyboard, network, and physical-device sign-off steps. Tagged builds use [the mobile release workflow](../.github/workflows/mobile-release.yml) and publish a tested `dist/` bundle as a workflow artifact. The artifact is not automatically deployed to a public hosting provider; configure your HTTPS static host separately.

## Run the authenticated gateway
See [gateway/README.md](./gateway/README.md) for setup, environment variables, and network hardening. Start it separately with `npm run gateway`. Configure the gateway URL and its bearer token in the PWA Settings.

```bash
npm ci
npm test
npm run build
```
