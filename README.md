# Axiom — Mobile AI Command Center

A touch-first Progressive Web App built with React, Vite, Tailwind CSS, and Lucide.

## Run locally
```bash
npm install
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
- MCP Streamable HTTP initialize and tool discovery; discovered tools are registered for model use
- Collapsible execution traces and installable PWA shell

## Security and transport notes
- LocalStorage is not encrypted. The PWA stores configured tokens on this device because this is a local-first prototype; never enter production, organization-wide, service-role, or Supabase secret keys. Use least-privilege GitHub tokens and Supabase publishable keys.
- Supabase's REST OpenAPI schema is no longer available to anon/publishable-key requests. Table and column discovery therefore uses a project-owned `exec_sql` RPC; the app does not create that function or grant it permissions. Only connect a narrowly permissioned RPC that you have reviewed. Do not implement it as a broadly executable SECURITY DEFINER function.
- Supabase SQL execution is only available if you deliberately provide a permission-controlled `exec_sql` RPC. No generic privileged SQL endpoint is bundled.
- Browser MCP requires server CORS support. Streamable HTTP is implemented; legacy SSE-only transport and auth-header support remain follow-up work. A same-origin authenticated proxy is recommended for production.
- Browser-to-Ollama requests require CORS permission. Android localhost routing depends on where Ollama is hosted. HTTPS pages may block plain HTTP connections depending on browser security policy.

## Build
```bash
npm install
npm run build
```
