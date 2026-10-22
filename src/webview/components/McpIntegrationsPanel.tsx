import { createMemo, createSignal, For, onMount, Show } from "solid-js";

type McpEntry = {
  id: string; name: string; category: string; transport: string; auth: string[];
  riskLabel: string; sourceUrl: string; description: string;
  state: "unconfigured" | "configured" | "disabled"; enabled: boolean; hasSecret: boolean;
  endpoint?: string | null; requiresRestart?: boolean; package?: string | null; managed?: boolean; reviewNote?: string;

};
type McpApi = {
  status: () => Promise<McpEntry[]>;
  saveSecret: (request: { id: string; secret: string }) => Promise<{ saved: boolean; requiresRestart: boolean }>;
  setEnabled: (request: { id: string; enabled: boolean }) => Promise<{ requiresRestart: boolean }>;
  remove: (id: string) => Promise<{ removed: boolean; requiresRestart: boolean }>;
  diagnostics: () => Promise<{ runtimeReachable: boolean; runtimeVersion?: string | null; runtimeHealthy?: boolean | null; toolDiscoveryAvailable?: boolean; toolIds: string[]; servers: Array<{ id: string; status: string; connected: boolean; tools: string[]; error?: string }>; error?: string; integrations: McpEntry[] }>;
  probeWorker: (id: string) => Promise<{ invoked: boolean; toolName: string | null; status: string; message: string }>;
};
const CATEGORIES = ["All", "Development", "Database", "Browser", "Search", "Web extraction", "Documentation"];
const SECRET_IDS = new Set(["brave-search", "crawl4ai", "postgresql", "sqlite"]);
const REMOTE_IDS = new Set(["github", "context7", "supabase", "neon", "exa"]);

function api(): McpApi | undefined {
  return (window as Window & { axiomDesktop?: { mcp?: McpApi } }).axiomDesktop?.mcp;
}

export function McpIntegrationsPanel() {
  const [category, setCategory] = createSignal("All");
  const [query, setQuery] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const [busyId, setBusyId] = createSignal("");
  const [entries, setEntries] = createSignal<McpEntry[]>([]);
  const [secrets, setSecrets] = createSignal<Record<string, string>>({});
  const [loading, setLoading] = createSignal(true);
  const [liveDiagnostics, setLiveDiagnostics] = createSignal<{ runtimeReachable: boolean; runtimeVersion?: string | null; runtimeHealthy?: boolean | null; toolDiscoveryAvailable?: boolean; toolIds: string[]; servers: Array<{ id: string; status: string; connected: boolean; tools: string[]; error?: string }>; error?: string } | null>(null);
  const [probeBusyId, setProbeBusyId] = createSignal("");
  const connectedApi = api();
  const visibleEntries = createMemo(() => entries().filter(item =>
    (category() === "All" || item.category === category()) &&
    (item.name + " " + item.description + " " + item.category).toLowerCase().includes(query().trim().toLowerCase())
  ));

  async function refresh() {
    if (!connectedApi) {
      setNotice("MCP connections are available in the Axiom desktop app. The browser preview cannot store credentials or configure runtime integrations.");
      setLoading(false);
      return;
    }
    try {
      const [status, diagnostics] = await Promise.all([
        connectedApi.status(),
        connectedApi.diagnostics().catch(() => null)
      ]);
      setEntries(status);
      if (diagnostics) setLiveDiagnostics(diagnostics);
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }
  onMount(() => { void refresh(); });

  async function enable(entry: McpEntry) {
    if (!connectedApi) return;
    setBusyId(entry.id); setNotice("");
    try {
      await connectedApi.setEnabled({ id: entry.id, enabled: !entry.enabled });
      await refresh();
      setNotice(entry.name + (!entry.enabled ? " enabled in the Axiom runtime configuration. Restart Axiom to load it; OAuth-enabled servers may then prompt you to sign in." : " disabled. Restart Axiom to unload it."));
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(""); }
  }

  async function saveSecret(entry: McpEntry) {
    if (!connectedApi) return;
    const secret = secrets()[entry.id] || "";
    setBusyId(entry.id); setNotice("");
    try {
      await connectedApi.saveSecret({ id: entry.id, secret });
      setSecrets(previous => ({ ...previous, [entry.id]: "" }));
      await refresh();
      setNotice(entry.name + " value encrypted in OS-backed secure storage. Enable the integration and restart Axiom, then inspect live diagnostics to verify the connection and discovered tools.");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(""); }
  }

  async function probeWorker(entry: McpEntry) {
    if (!connectedApi) return;
    setProbeBusyId(entry.id); setNotice("");
    try {
      const result = await connectedApi.probeWorker(entry.id);
      setNotice(result.message + (result.toolName ? " Tool: " + result.toolName : ""));
      await refresh();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setProbeBusyId(""); }
  }

  function diagnosticFor(id: string) {
    return liveDiagnostics()?.servers?.find(item => item.id === id);
  }

  async function remove(entry: McpEntry) {
    if (!connectedApi) return;
    setBusyId(entry.id); setNotice("");
    try {
      await connectedApi.remove(entry.id);
      await refresh();
      setNotice(entry.name + " configuration and saved credential removed. Restart Axiom to unload any running server.");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(""); }
  }

  return (
    <section class="workflow-plan workflow-plan--plugins" aria-label="MCP integrations catalog">
      <div class="workflow-plan__eyebrow">MCP INTEGRATIONS <span>CURATED CATALOG</span></div>
      <h2>Connect your tools</h2>
      <p class="workflow-plan__prompt">Configure supported MCP servers without hand-editing JSON. Secrets stay in the desktop main process and are encrypted with OS-backed storage. A configured entry is not proof that its server has connected or exposed tools.</p>
      <label class="omniroute-setup__field">Search integrations
        <input value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder="GitHub, database, search…" />
      </label>
      <div class="workflow-plan__actions" aria-label="Filter integrations">
        <For each={CATEGORIES}>{item => <button type="button" class="workflow-plan__secondary" aria-pressed={category() === item} onClick={() => setCategory(item)}>{item}</button>}</For>
      </div>
      <Show when={loading()}><p role="status">Loading integration status…</p></Show>
      <section class="workflow-plan__parallel" aria-label="Live MCP diagnostics">
        <div class="workflow-plan__eyebrow">RUNTIME DIAGNOSTICS <span>{liveDiagnostics()?.runtimeReachable ? "RUNTIME REACHABLE" : "RUNTIME UNAVAILABLE"}</span></div>
        <p>{liveDiagnostics()?.runtimeReachable ? "The Axiom runtime answered its MCP status API." : "Axiom could not verify live MCP status. A saved credential is not a connected integration."}</p>
        <p>Bundled runtime: {liveDiagnostics()?.runtimeVersion || "version endpoint unavailable"}{liveDiagnostics()?.runtimeHealthy === true ? " · healthy" : ""}</p>
        <p>Tool discovery: {liveDiagnostics()?.toolDiscoveryAvailable ? "available" : "not verified by this runtime API"}</p>
        <Show when={liveDiagnostics()?.error}><p role="status">{liveDiagnostics()?.error}</p></Show>
        <Show when={liveDiagnostics()?.runtimeReachable}>
          <p>Discovered runtime tool IDs: {liveDiagnostics()?.toolIds?.length ? liveDiagnostics()?.toolIds?.join(", ") : "none reported"}</p>
        </Show>
        <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || !!probeBusyId()} onClick={() => void refresh()}>Refresh diagnostics</button>
      </section>
      <div class="workflow-plan__actions">
        <For each={visibleEntries()}>{entry =>
          <article class="workflow-plan__parallel" aria-label={entry.name}>
            <div class="workflow-plan__eyebrow">{entry.category} <span>{diagnosticFor(entry.id)?.connected ? "CONNECTED" : entry.enabled ? "ENABLED · CONNECTION NOT VERIFIED" : entry.hasSecret ? "CREDENTIAL SAVED" : "NOT CONFIGURED"}</span></div>
            <strong>{entry.name}</strong>
            <p>{entry.description}</p>
            <span>Transport: {entry.transport}</span>
            <span>Sign-in/setup: {entry.auth.join(" · ")}</span>
            <p><strong>Permission note:</strong> {entry.riskLabel}</p>
            <Show when={entry.package}><p>Reviewed package: <code>{entry.package}</code></p></Show>
            <Show when={diagnosticFor(entry.id)}><p>Connection: {diagnosticFor(entry.id)?.status}. Tools: {diagnosticFor(entry.id)?.tools?.join(", ") || "none discovered"}.</p><Show when={diagnosticFor(entry.id)?.error}><p role="status">{diagnosticFor(entry.id)?.error}</p></Show></Show>
            <Show when={entry.reviewNote}><p role="status">{entry.reviewNote}</p></Show>
            <Show when={entry.enabled}>
              <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || !!probeBusyId()} onClick={() => void probeWorker(entry)}>
                {probeBusyId() === entry.id ? "Verifying worker tool call…" : "Verify real worker tool call"}
              </button>
            </Show>
            <Show when={SECRET_IDS.has(entry.id)}>
              <label class="omniroute-setup__field"> {entry.id === "brave-search" ? "Brave Search API key" : entry.id === "crawl4ai" ? "Optional Crawl4AI bearer token (local API at 127.0.0.1:11235)" : entry.id === "postgresql" ? "PostgreSQL connection URL (use a read-only database role)" : "SQLite database file path (must be inside the current project)"}
                <input type="password" autocomplete="off" value={secrets()[entry.id] || ""} onInput={event => setSecrets(previous => ({ ...previous, [entry.id]: event.currentTarget.value }))} placeholder={entry.hasSecret ? "Saved securely · enter a replacement to rotate" : entry.id === "postgresql" ? "postgresql://user:password@host:5432/database" : entry.id === "sqlite" ? "Absolute path to an approved .db file" : entry.id === "crawl4ai" ? "Optional bearer token for local Crawl4AI service" : "Paste API key"} />
              </label>
              <div class="workflow-plan__actions">
                <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || !(secrets()[entry.id] || "").trim()} onClick={() => void saveSecret(entry)}>{busyId() === entry.id ? "Saving…" : "Save key securely"}</button>
                <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || (!entry.hasSecret && entry.id !== "crawl4ai")} onClick={() => void enable(entry)}>{entry.enabled ? "Disable server" : "Enable server (may download package)"}</button>
                <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || !entry.hasSecret} onClick={() => void remove(entry)}>Remove saved key</button>
              </div>
            </Show>
            <Show when={REMOTE_IDS.has(entry.id)}>
              <p>Remote MCP endpoint: <code>{entry.endpoint}</code>. Axiom runtime manages OAuth for remote MCP servers when the provider supports it.</p>
              <button type="button" class="workflow-plan__secondary" disabled={!!busyId()} onClick={() => void enable(entry)}>{busyId() === entry.id ? "Saving…" : entry.enabled ? "Disable integration" : "Enable and sign in"}</button>
            </Show>
            <Show when={!SECRET_IDS.has(entry.id) && !REMOTE_IDS.has(entry.id)}>
              <p>Managed setup is not yet implemented for this provider. It cannot be enabled from this screen.</p>
              <button type="button" class="workflow-plan__secondary" onClick={() => setNotice("Official source: " + entry.sourceUrl)}>Show official source</button>
            </Show>
          </article>
        }</For>
      </div>
      <Show when={notice()}><p role="status" class="omniroute-setup__message">{notice()}</p></Show>
      <small class="omniroute-setup__note">Remote OAuth and local MCP tools may require an Axiom restart. API keys are encrypted at rest, but are injected into the OpenCode runtime environment while the server is running. Connection states come from the live Axiom runtime API. Worker verification creates a diagnostic session and only passes when the response contains an MCP tool-call part for the selected server. PostgreSQL uses DBHub in read-only mode and still requires a least-privilege database role; SQLite paths are restricted to the current project. Fetch uses the pinned official Python reference server via uvx. Crawl4AI uses a pinned stdio bridge and expects a separately running local API service at 127.0.0.1:11235.</small>
    </section>
  );
}
