# Axiom Mobile PWA Architecture

## Product direction
Axiom includes an Android-first React PWA in `pwa/`, alongside the standalone desktop application at the repository root. The two apps have independent package manifests and build pipelines.

## Frontend
- React + Vite
- Tailwind CSS
- Lucide React
- Touch-first bottom navigation
- Installable PWA manifest and service worker

## Implemented runtime
1. Local model adapter: Ollama model discovery, streamed `/api/generate`, and streamed `/api/chat` tool-calling loops.
2. Tool registry: async handlers, JSON-schema-shaped input validation, tool discovery, and execution lifecycle events.
3. GitHub adapter: Octokit-based file reads, file creation, and file updates/commits.
4. Supabase adapter: table listing/column inspection through an explicitly project-configured `exec_sql` RPC, row selection through the Data API, and optional SQL RPC calls.
5. MCP transports: Streamable HTTP session initialization and legacy SSE event transport; discovered tool schemas are injected into Ollama chat.
6. Event log: request, approval, execution, result, and error records.
7. Persistence: chats, endpoint registrations, preferences, and credentials are stored in LocalStorage.

## Security boundaries
- LocalStorage is not encrypted. Conversations and preferences are persisted, while integration and gateway credentials are kept in memory only. The authenticated Node gateway holds GitHub and MCP credentials and the Supabase publishable key.
- Never expose Supabase service-role or secret keys in browser code. Use publishable keys and least-privilege database grants/RLS.
- Supabase SQL and schema introspection require a project-owned, permission-controlled RPC. The app does not create or authorize that function. Do not expose an unrestricted SQL executor or a broadly executable SECURITY DEFINER function.
- GitHub write operations, SQL execution, and MCP tools without explicit read-only annotations require user approval.
- Browser MCP connections require CORS. Legacy EventSource transport cannot attach custom authorization headers; use a same-origin authenticated proxy for protected servers.
- Browser-to-Ollama requests require CORS permission and correct Android localhost routing.

## Remaining delivery work
- Complete physical Android verification and validate the gateway on the actual host/network topology.
- Generate and commit the npm lockfile for the pinned direct dependencies (a manual GitHub Actions workflow is provided).
- Run CI build and automated tests, then install and verify on Android Chrome.
- Improve Markdown rendering, conversation management, and explicit tool approval UX.
