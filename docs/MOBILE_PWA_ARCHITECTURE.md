# Axiom Mobile PWA Architecture

## Product direction
Axiom is restarting as an Android-first PWA in the existing repository. This branch is intentionally independent of the legacy desktop application and preserves its history.

## Frontend
- React + Vite
- Tailwind CSS
- Lucide React
- Touch-first bottom navigation
- Installable PWA manifest and service worker

## Runtime modules (planned)
1. Local model adapter: Ollama tags discovery and streaming generate API.
2. Tool registry: typed async handlers and JSON Schema validation.
3. Provider adapters: GitHub via Octokit and Supabase via supabase-js.
4. MCP transport adapter: Streamable HTTP first, legacy SSE where supported; server capability and session negotiation.
5. Event bus: structured request, tool, result, and error events.

## Security boundaries
A browser PWA cannot safely protect privileged API tokens in LocalStorage. Local persistence is acceptable only as an explicit convenience for user-controlled, low-risk credentials. Production-grade integrations should use a local companion service or a narrowly scoped server-side proxy, avoid logging secrets, and require confirmation for destructive actions. Never expose Supabase service-role keys in a browser client.

## Delivery sequence
- M0: React PWA shell, responsive navigation, persistence, Ollama streaming, basic logs.
- M1: Tool registry contract and GitHub/Supabase adapters.
- M2: MCP Streamable HTTP/SSE transport and schema discovery.
- M3: Authenticated local gateway/proxy, safe credential storage, real tool execution, tests and Android install verification.
