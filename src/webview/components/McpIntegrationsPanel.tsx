import { createMemo, createSignal, For, onMount, Show } from "solid-js";

type McpEntry = {
  id: string; name: string; category: string; transport: string; auth: string[];
  riskLabel: string; sourceUrl: string; description: string;
  state: "unconfigured" | "configured" | "disabled"; enabled: boolean; hasSecret: boolean;
  endpoint?: string | null; requiresRestart?: boolean;
};
type McpApi = {
  status: () => Promise<McpEntry[]>;
  saveSecret: (request: { id: string; secret: string }) => Promise<{ saved: boolean; requiresRestart: boolean }>;
  setEnabled: (request: { id: string; enabled: boolean }) => Promise<{ requiresRestart: boolean }>;
  remove: (id: string) => Promise<{ removed: boolean; requiresRestart: boolean }>;
};
const CATEGORIES = ["All", "Development", "Database", "Browser", "Search", "Web extraction", "Documentation"];
const SECRET_IDS = new Set(["brave-search", "exa"]);
const REMOTE_IDS = new Set(["context7", "supabase"]);

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
  const connectedApi = api();
  const visibleEntries = createMemo(() => entries().filter(item =>
    (category() === "All" || item.category === category()) &&
    (item.name + " " + item.description + " " + item.category).toLowerCase().includes(query().trim().toLowerCase())
  ));

  async function refresh() {
    if (!connectedApi) {
      setNotice("MCP connections are available in the Axiom desktop app. The browser preview cannot store credentials or configure OpenCode.");
      setLoading(false);
      return;
    }
    try { setEntries(await connectedApi.status()); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setLoading(false); }
  }
  onMount(() => { void refresh(); });

  async function enable(entry: McpEntry) {
    if (!connectedApi) return;
    setBusyId(entry.id); setNotice("");
    try {
      await connectedApi.setEnabled({ id: entry.id, enabled: !entry.enabled });
      await refresh();
      setNotice(entry.name + (!entry.enabled ? " enabled in OpenCode configuration. Restart Axiom to load it; OAuth-enabled servers may then prompt you to sign in." : " disabled. Restart Axiom to unload it."));
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
      setNotice(entry.name + " credential encrypted in OS-backed secure storage. Explicitly enable the server when ready; this may download and execute its published MCP package. Axiom does not verify the key until the runtime connects.");
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusyId(""); }
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
      <div class="workflow-plan__actions">
        <For each={visibleEntries()}>{entry =>
          <article class="workflow-plan__parallel" aria-label={entry.name}>
            <div class="workflow-plan__eyebrow">{entry.category} <span>{entry.enabled ? "ENABLED · RESTART REQUIRED" : entry.hasSecret ? "CREDENTIAL SAVED" : "NOT CONFIGURED"}</span></div>
            <strong>{entry.name}</strong>
            <p>{entry.description}</p>
            <span>Transport: {entry.transport}</span>
            <span>Sign-in/setup: {entry.auth.join(" · ")}</span>
            <p><strong>Permission note:</strong> {entry.riskLabel}</p>
            <Show when={SECRET_IDS.has(entry.id)}>
              <label class="omniroute-setup__field"> {entry.id === "brave-search" ? "Brave Search API key" : "Exa API key"}
                <input type="password" autocomplete="off" value={secrets()[entry.id] || ""} onInput={event => setSecrets(previous => ({ ...previous, [entry.id]: event.currentTarget.value }))} placeholder={entry.hasSecret ? "Saved securely · enter a replacement to rotate" : "Paste API key"} />
              </label>
              <div class="workflow-plan__actions">
                <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || !(secrets()[entry.id] || "").trim()} onClick={() => void saveSecret(entry)}>{busyId() === entry.id ? "Saving…" : "Save key securely"}</button>
                <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || !entry.hasSecret} onClick={() => void enable(entry)}>{entry.enabled ? "Disable server" : "Enable server (may download package)"}</button>
                <button type="button" class="workflow-plan__secondary" disabled={!!busyId() || !entry.hasSecret} onClick={() => void remove(entry)}>Remove saved key</button>
              </div>
            </Show>
            <Show when={REMOTE_IDS.has(entry.id)}>
              <p>Remote MCP endpoint: <code>{entry.endpoint}</code>. The bundled OpenCode runtime handles OAuth if supported by the provider.</p>
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
      <small class="omniroute-setup__note">Remote OAuth and local MCP tools may require an Axiom restart. API keys are encrypted at rest, but are injected into the OpenCode runtime environment while the server is running. Only Context7, Supabase, Brave Search, and Exa currently have connection configuration implemented; the remaining catalog entries are visible but intentionally unavailable until their installers and permission controls are reviewed.</small>
    </section>
  );
}
