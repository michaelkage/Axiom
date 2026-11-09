# Axiom — Mobile AI Command Center

A mobile-first Progressive Web App built with React, Tailwind CSS, and Lucide.

## Run locally
```bash
npm install
npm run dev -- --host 0.0.0.0
```

Open the Vite network URL from your Android browser. For Android/Termux, keep Ollama reachable at `http://localhost:11434` when the browser and Ollama share the same device/network namespace.

## Current foundation
- Responsive touch-first navigation: Chat, Tools, MCP, Logs
- Ollama `/api/tags` connection check and streaming `/api/generate`
- Persistent chat history and preferences in LocalStorage
- Initial GitHub and Supabase tool registry toggles
- MCP HTTP endpoint registration and basic tools/list discovery
- Collapsible execution event details
- Installable PWA manifest and service worker shell cache

## Important integration boundaries
- LocalStorage is not encrypted. Do not store production secrets or high-privilege tokens there.
- Browser-to-Ollama requests require Ollama to permit the browser origin (CORS). Android localhost routing depends on how Ollama is hosted.
- Browser MCP access is subject to CORS and the MCP transport/session handshake. Production use should place a small authenticated same-origin backend proxy between the PWA and remote MCP servers.
- GitHub and Supabase actions are not yet wired to authenticated backends. The registry currently exposes enablement state only; never treat a toggle as a working integration.

## Build
```bash
npm run build
```
