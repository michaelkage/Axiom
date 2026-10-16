# Axiom MCP Integrations: implementation blueprint

**Status:** Runtime diagnostics and a worker tool-call probe are implemented against OpenCode MCP status/tool-ID APIs. Remote MCP presets use OAuth-capable endpoints for GitHub, Supabase, Context7, Neon, and Exa. Reviewed local presets include pinned Playwright, Brave Search, DBHub for PostgreSQL/SQLite, the official Fetch reference server via `uvx`, and the Crawl4AI stdio bridge. Crawl4AI requires a separately running API service at `127.0.0.1:11235` by default. The bundled runtime API shapes, OAuth handshakes, and provider-specific end-to-end tool calls still require verification in a running packaged Axiom build.

## Product goal

Make Model Context Protocol (MCP) integrations feel like connecting an account, not hand-editing configuration. Users should browse curated integrations, connect through the provider's supported authentication flow where possible, test the connection, and choose which projects/workers can use the tools.

## Initial catalog

| Integration | Recommended starting point | Authentication/setup | Risk notes |
| --- | --- | --- | --- |
| GitHub | Official GitHub MCP server, using its supported OAuth flow where compatible | Browser OAuth first; scoped PAT fallback | Repository write access must be explicit; default to least privilege |
| Supabase | Official hosted MCP endpoint `https://mcp.supabase.com/mcp` | OAuth where supported by the MCP client; otherwise documented credential flow | Prefer read-only mode and selected project scoping; warn about database writes |
| Microsoft Playwright | Microsoft-maintained `@playwright/mcp` local stdio server | Managed local package/runtime; no cloud account needed for basic browser automation | Browser automation can interact with authenticated sites; show tool permissions and origin context |
| Brave Search | Official Brave Search MCP server | Brave Search API key stored securely | Key has service usage/cost implications; never expose it to renderer logs |
| Exa | Official hosted endpoint `https://mcp.exa.ai/mcp` | Prefer OpenCode-managed OAuth; hosted endpoint may also support API-key authentication | Explain quota/cost and data sent to the search service |
| Crawl4AI | `crawl4ai-mcp-sse-stdio@1.2.1` bridge | Optional bearer token in OS-backed storage; expects a separately running local Crawl4AI API at `127.0.0.1:11235` | Browser/network access can reach private/internal hosts; endpoint is fixed to loopback in the current setup |
| Fetch | Official Python reference server `mcp-server-fetch==2026.7.10` via `uvx` | No provider credential; requires `uvx` to be installed | Fetch can access network URLs; review untrusted URLs and private-network access |
| PostgreSQL | A curated, reviewed PostgreSQL MCP server | Host, port, database, user, TLS, and password or supported secret reference | Read-only role recommended; block unsafe defaults and explain direct database access |
| SQLite | A curated, reviewed SQLite MCP server | Select a database file inside the workspace or explicitly approved path | Restrict file access to approved paths; never accept arbitrary paths silently |
| Neon | Official Neon MCP server | Provider-supported OAuth/API-key flow as supported by the chosen server | Project/branch scoping; explain that database actions can mutate hosted resources |
| Context7 | Official remote endpoint `https://mcp.context7.com/mcp` | OAuth when supported; optional API key for applicable plan/features | Documentation retrieval still sends queries to an external service |

Package names, URLs, authentication behavior, and maintenance status must be checked against each publisher's current official documentation before a preset is enabled by default. The catalog should record its publisher, official source URL, transport, auth mode, version/release policy, permissions, and last review date.

## Architecture

1. **Curated catalog:** declarative, versioned entries only. Catalog metadata must not contain executable arbitrary shell strings that are blindly run.
2. **Integration UI:** search/filter catalog, view requested permissions, connect, test, enable/disable, and remove.
3. **Credential broker:** Electron main-process-only access to OS-backed secure storage. The renderer receives presence/status metadata, never secret values after save.
4. **Runtime adapter:** translates reviewed catalog entries to the supported OpenCode MCP configuration/API schema. It must merge with existing OpenCode/project configuration rather than overwrite user settings.
5. **Authentication:** prefer OpenCode's built-in MCP OAuth support for remote servers when supported by the bundled runtime. Avoid implementing provider OAuth flows independently when the MCP authorization flow already works. Use PAT/API-key fallback only when necessary.
6. **Connection diagnostics:** distinguish not configured, authentication required, connected, tool discovery failed, runtime restart required, and provider outage. Never display a green Connected state merely because a credential was saved.
7. **Tool access policy:** server-level enablement plus project/workflow scoping. Prefer read-only modes when available. Surface write, shell, browser, database, and private-network capabilities before enabling them.

## Security requirements

- Keep credentials out of renderer storage, logs, project files, exported configs, and support bundles.
- Use Electron `safeStorage` and fail closed when it is unavailable; do not silently fall back to plaintext.
- Validate HTTPS remote endpoints and restrict unsafe local/private network access for remote servers where practical.
- Validate local package identity, version, arguments, working directory, and installation path. Avoid unpinned `npx -y` execution as an invisible side effect.
- Do not run installers or launch new local servers without explicit user consent.
- Set connection and tool-discovery timeouts; surface actionable errors; clean up partial installation artifacts.
- Avoid enabling every discovered tool globally by default. MCP tools increase context consumption and can carry significant authority.
- Test config merging, secret redaction, safe-storage failures, URL validation, malformed catalog entries, and runtime connection errors.

## Delivery plan

### Stage 1: catalog and contracts
- Add the curated catalog schema and provider metadata.
- Define typed status/auth/config contracts and tests.
- Add an Integrations panel entry point that is usable from onboarding and later settings.
- Mark all integration states as unconfigured until a real runtime handshake confirms otherwise.

### Stage 2: runtime and secret storage
- Add a main-process credential broker and encrypted persistence.
- Add a runtime adapter for the bundled OpenCode version, preserving existing configuration.
- Add one remote OAuth integration (Context7 or Supabase) and one local stdio integration (Playwright) as end-to-end reference implementations.

### Stage 3: provider rollout
- Add GitHub, Supabase, Context7, Brave Search, and Exa, then local database/browser services.
- Add PostgreSQL, SQLite, Neon, Crawl4AI, and Fetch only after the exact maintained server/package is reviewed.
- Test tool availability in real worker sessions and show real connection diagnostics.

### Stage 4: quality and safety
- Add per-project enablement, least-privilege guidance, removal/logout, credential rotation, and support diagnostics.
- Test install/restart/recovery across Windows first, then macOS/Linux packaging.
- Publish a compatibility matrix tied to the bundled OpenCode runtime version.

## Acceptance criteria

- A user can select a catalog entry without writing JSON.
- OAuth is used where the official server and bundled runtime support it; otherwise the UI explains the required credential and why.
- Credentials are stored only in OS-backed secure storage and never returned to the renderer after save.
- A saved integration is not labelled connected until the runtime confirms it and discovers tools.
- Existing project and user OpenCode settings remain intact.
- Every preset has a source/provenance record, transport, auth method, permissions summary, and tests.
- Workers can actually invoke the integration's tools in a test session, with diagnostic evidence.
\n\n## Runtime diagnostics and worker probe\n\nAxiom queries the OpenCode MCP status endpoint and tool-ID endpoint, showing per-server status and matching tool names. The worker verification action creates a diagnostic OpenCode session and checks whether the resulting message includes an MCP tool-call part for the selected server. The check only passes when that response shape is present; mocked unit tests do not establish that the bundled runtime or a live provider actually passed. A packaged-runtime test and live OAuth/tool-call run are still required before calling the overall rollout verified.\n