# Axiom — Mobile AI Command Center

A touch-first Progressive Web App built with React, Vite, Tailwind CSS, and Lucide.

## Run locally
```bash
npm ci
npm run dev -- --host 0.0.0.0
```
Open the Vite network URL from Android. Ollama must be reachable from the browser at the configured base URL (default `http://localhost:11434`) and allow the PWA origin through CORS.

## Implemented
- Responsive bottom navigation: Chat, Models, Files, Skills, Terminal, Tools, MCP, and Logs
- Fast startup status overlay with a bounded runtime handshake, retry, and offline continuation
- Persistent Dark, Light, and High-Contrast themes with a user-selected accent color
- Browser speech dictation in the composer with interim transcript feedback and editable text
- Image and project/text attachments, client-side image compression, and a strict 1 MiB aggregate attachment cap per prompt (up to eight files)
- Android Web Share Target for shared text, URLs, logs, and supported files, handed off through IndexedDB by the service worker
- Ollama model discovery and streamed /api/chat responses with bounded transient-error retries, Retry-After support, and cancellation
- Mobile source editor with syntax highlighting, line numbers, find/replace, revert, and safe save/export
- Structured conversation outcome summaries covering changes, file paths, verification evidence, and next steps
- Curated skills registry with manifest validation, full instruction inspection, custom HTTPS manifest installs, updates, and per-task activation
- LocalStorage persistence for chats, preferences, endpoints, skills, and settings
- Async JSON-schema tool registry with execution events
- GitHub tools: read files, create files, update files/commits
- Supabase tools: list/describe tables, select rows, and optional project-defined SQL RPC
- MCP Streamable HTTP and legacy SSE; discovered tools are schema-injected and registered for model use
- Collapsible execution traces and installable offline PWA shell
- Android native PTY shell, app-private project workspaces, foreground runtime service, and Android Keystore-backed gateway pairing (APK only)

### Mobile workspace boundaries
- Voice dictation uses the browser Web Speech API. Browser support and speech-service availability vary; unsupported browsers keep normal text input available.
- Image attachments are sent as Ollama images payloads. The current native llama.cpp chat path is text-only and clearly notes when image pixels cannot be processed.
- Attachment content is held in memory for the active session. Image bytes are excluded from LocalStorage persistence to avoid bloating or exhausting browser storage.
- The Files editor opens user-selected files into an isolated in-memory buffer. Where the File System Access API is unavailable, Save exports an edited copy instead of overwriting the source. It is not a browser bridge into Axiom's app-private Android project workspace.
- Outcome summaries are evidence-based extraction from conversation text and execution logs. They do not run tests or independently verify claims.
- Skills are prompt-level guidance, not executable plugins. Declared permissions do not grant capabilities; existing tool registration and approval controls remain authoritative. Project-level activation will follow a project/workspace model; current activation is per conversation/task.

## Security and transport notes
- Browser storage is not encrypted. Conversations and non-secret preferences are stored locally; browser-mode GitHub, Supabase, MCP, and gateway credentials are memory-only. The Android APK stores only the gateway pairing credential encrypted with Android Keystore; its short-lived session token stays in memory.
- Use the authenticated gateway for Ollama, GitHub, Supabase, and gateway-managed Streamable HTTP MCP. GitHub PATs, Supabase publishable keys, and MCP bearer tokens remain in the gateway process. Never configure a Supabase service-role/secret key.
- GitHub gateway access is restricted to content reads/writes for one configured repository. SQL execution and remote MCP tools require explicit per-call approval. MCP annotations are supplied by remote servers and are treated as advisory, not as a trusted security boundary.
- Supabase's REST OpenAPI schema is no longer available to anon/publishable-key requests. Table and column discovery therefore uses a project-owned `exec_sql` RPC; the app does not create that function or grant it permissions. Only connect a narrowly permissioned RPC that you have reviewed. Do not implement it as a broadly executable SECURITY DEFINER function.
- Supabase SQL execution is only available if you deliberately provide a permission-controlled `exec_sql` RPC. No generic privileged SQL endpoint is bundled.
- Browser MCP requires server CORS support. Streamable HTTP and legacy SSE are implemented; legacy EventSource cannot attach custom authorization headers, so a same-origin authenticated proxy is recommended for protected production servers.
- Browser-to-Ollama requests require CORS permission. Android localhost routing depends on where Ollama is hosted. HTTPS pages may block plain HTTP connections depending on browser security policy.

## Deployment
See [DEPLOYMENT.md](./DEPLOYMENT.md) for static hosting, gateway topology, and tagged release instructions.

See [ANDROID_VALIDATION.md](./ANDROID_VALIDATION.md) for Chrome installation, standalone-mode, offline, keyboard, network, and physical-device sign-off steps. Web-only builds use [the mobile release workflow](../.github/workflows/mobile-release.yml) and publish a tested `dist/` bundle. For native shell, workspace, and background-runtime behavior, see [ANDROID_RUNTIME.md](./ANDROID_RUNTIME.md). For an installable Android app, use [the Android APK release workflow](../.github/workflows/android-release.yml): it wraps the production build with Capacitor, builds `Axiom-Android-arm64-debug.apk`, and uploads it as a workflow artifact. An `android-v*` tag also publishes the APK on the repository's GitHub Releases page. This initial APK is debug-signed for sideload/testing, not a Play Store production-signed release.

## Run the authenticated gateway
See [gateway/README.md](./gateway/README.md) for setup, environment variables, and network hardening. Start it separately with `npm run gateway`. In the installed Android app, the Termux bootstrap pairs the local gateway automatically and stores its credential in Android Keystore. Browser-only PWA mode requires a manually supplied gateway bearer token in Settings; it remains in memory and is cleared on reload.

```bash
npm ci
npm test
npm run build
```
