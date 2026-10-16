import { createMemo, createSignal, For, Show } from "solid-js";

type McpEntry = {
  id: string;
  name: string;
  category: string;
  transport: string;
  auth: string[];
  riskLabel: string;
  sourceUrl: string;
  description: string;
  state: "unconfigured";
};

const CATALOG: McpEntry[] = [
  { id: "github", name: "GitHub", category: "Development", transport: "Remote or local", auth: ["Browser sign-in", "PAT fallback"], riskLabel: "May write to repositories", sourceUrl: "https://github.com/github/github-mcp-server", description: "Repositories, issues, pull requests, and code search.", state: "unconfigured" },
  { id: "supabase", name: "Supabase", category: "Database", transport: "Remote HTTP", auth: ["OAuth where supported"], riskLabel: "Database access can change data", sourceUrl: "https://supabase.com/docs/guides/getting-started/mcp", description: "Inspect and manage Supabase projects and database resources.", state: "unconfigured" },
  { id: "playwright", name: "Microsoft Playwright", category: "Browser", transport: "Local stdio", auth: ["No cloud sign-in for basic use"], riskLabel: "Can control a browser", sourceUrl: "https://github.com/microsoft/playwright-mcp", description: "Automate browser workflows and inspect web applications.", state: "unconfigured" },
  { id: "brave-search", name: "Brave Search", category: "Search", transport: "Local stdio", auth: ["Brave Search API key"], riskLabel: "Sends searches to an external provider", sourceUrl: "https://github.com/brave/brave-search-mcp-server", description: "Search the web using Brave Search.", state: "unconfigured" },
  { id: "exa", name: "Exa", category: "Search", transport: "Server-dependent", auth: ["Exa API key"], riskLabel: "Sends searches to an external provider", sourceUrl: "https://github.com/exa-labs/exa-mcp-server", description: "Search and retrieve relevant web content.", state: "unconfigured" },
  { id: "crawl4ai", name: "Crawl4AI", category: "Web extraction", transport: "Server-dependent", auth: ["Depends on deployment"], riskLabel: "Can crawl network-accessible pages", sourceUrl: "https://github.com/unclecode/crawl4ai", description: "Crawl and extract structured content from web pages.", state: "unconfigured" },
  { id: "fetch", name: "Fetch", category: "Web extraction", transport: "Local stdio", auth: ["Usually none"], riskLabel: "Can fetch network-accessible pages", sourceUrl: "https://github.com/modelcontextprotocol/servers", description: "Fetch web pages and extract readable content. Exact maintained implementation needs review.", state: "unconfigured" },
  { id: "postgresql", name: "PostgreSQL", category: "Database", transport: "Local stdio", auth: ["Database connection details"], riskLabel: "Database access can change data", sourceUrl: "https://github.com/modelcontextprotocol/servers", description: "Query PostgreSQL using a least-privilege database role.", state: "unconfigured" },
  { id: "sqlite", name: "SQLite", category: "Database", transport: "Local stdio", auth: ["Approved database file"], riskLabel: "Can access an approved local database file", sourceUrl: "https://github.com/modelcontextprotocol/servers", description: "Inspect and query an explicitly approved SQLite database file.", state: "unconfigured" },
  { id: "neon", name: "Neon", category: "Database", transport: "Server-dependent", auth: ["Provider-supported OAuth or API key"], riskLabel: "Can change hosted database resources", sourceUrl: "https://github.com/neondatabase/mcp-server-neon", description: "Manage Neon projects, branches, and database resources.", state: "unconfigured" },
  { id: "context7", name: "Context7", category: "Documentation", transport: "Remote HTTP", auth: ["OAuth where supported; API key optional for applicable use"], riskLabel: "Sends documentation queries to an external provider", sourceUrl: "https://github.com/upstash/context7", description: "Retrieve current library documentation for coding tasks.", state: "unconfigured" }
];

const CATEGORIES = ["All", "Development", "Database", "Browser", "Search", "Web extraction", "Documentation"];

export function McpIntegrationsPanel() {
  const [category, setCategory] = createSignal("All");
  const [query, setQuery] = createSignal("");
  const [notice, setNotice] = createSignal("");
  const entries = createMemo(() => CATALOG.filter(item =>
    (category() === "All" || item.category === category()) &&
    (item.name + " " + item.description + " " + item.category).toLowerCase().includes(query().trim().toLowerCase())
  ));

  return (
    <section class="workflow-plan workflow-plan--plugins" aria-label="MCP integrations catalog">
      <div class="workflow-plan__eyebrow">MCP INTEGRATIONS <span>CURATED CATALOG</span></div>
      <h2>Connect your tools</h2>
      <p class="workflow-plan__prompt">The goal is browser sign-in where supported, with secure credential entry as a fallback. No raw JSON required. This catalog is the first step; a listing here does not mean a server is installed or connected yet.</p>
      <label class="omniroute-setup__field">Search integrations
        <input value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder="GitHub, database, search…" />
      </label>
      <div class="workflow-plan__actions" aria-label="Filter integrations">
        <For each={CATEGORIES}>{item => <button type="button" class="workflow-plan__secondary" aria-pressed={category() === item} onClick={() => setCategory(item)}>{item}</button>}</For>
      </div>
      <div class="workflow-plan__actions">
        <For each={entries()}>{entry =>
          <article class="workflow-plan__parallel" aria-label={entry.name}>
            <div class="workflow-plan__eyebrow">{entry.category} <span>NOT CONNECTED</span></div>
            <strong>{entry.name}</strong>
            <p>{entry.description}</p>
            <span>Transport: {entry.transport}</span>
            <span>Sign-in/setup: {entry.auth.join(" · ")}</span>
            <p><strong>Permission note:</strong> {entry.riskLabel}</p>
            <div class="workflow-plan__actions">
              <button type="button" class="workflow-plan__secondary" onClick={() => setNotice(entry.name + ": the catalog entry is recorded, but runtime setup is not implemented yet. No credential was requested or saved.")}>Plan connection</button>
              <button type="button" class="workflow-plan__secondary" onClick={() => setNotice("Official source: " + entry.sourceUrl)}>Show official source</button>
            </div>
          </article>
        }</For>
      </div>
      <Show when={notice()}><p role="status" class="omniroute-setup__message">{notice()}</p></Show>
      <small class="omniroute-setup__note">Before any preset is enabled, Axiom must validate the publisher and package, store secrets in OS-backed secure storage, preserve existing OpenCode configuration, and confirm actual tool discovery in a worker session.</small>
    </section>
  );
}
