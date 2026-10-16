"use strict";

// Curated metadata only. No entry here is executed directly; the runtime adapter must
// validate these records and translate them to the exact bundled OpenCode MCP schema.
const MCP_CATALOG = Object.freeze([
  { id: "github", name: "GitHub", category: "Development", transport: "remote-or-local", auth: ["oauth", "pat"], risk: "write-access", sourceUrl: "https://github.com/github/github-mcp-server", description: "Repositories, issues, pull requests, and code search." },
  { id: "supabase", name: "Supabase", category: "Database", transport: "remote-http", auth: ["oauth"], endpoint: "https://mcp.supabase.com/mcp", risk: "database-write", sourceUrl: "https://supabase.com/docs/guides/getting-started/mcp", description: "Inspect and manage Supabase projects and database resources." },
  { id: "playwright", name: "Microsoft Playwright", category: "Browser", transport: "local-stdio", auth: [], package: "@playwright/mcp", risk: "browser-control", sourceUrl: "https://github.com/microsoft/playwright-mcp", description: "Automate browser workflows and inspect web applications." },
  { id: "brave-search", name: "Brave Search", category: "Search", transport: "local-stdio", auth: ["api-key"], package: "@brave/brave-search-mcp-server", secretFields: ["BRAVE_API_KEY"], risk: "external-search", sourceUrl: "https://github.com/brave/brave-search-mcp-server", description: "Search the web using Brave Search." },
  { id: "exa", name: "Exa", category: "Search", transport: "remote-or-local", auth: ["api-key"], risk: "external-search", sourceUrl: "https://github.com/exa-labs/exa-mcp-server", description: "Search and retrieve relevant web content." },
  { id: "crawl4ai", name: "Crawl4AI", category: "Web extraction", transport: "local-stdio-or-remote", auth: ["optional"], risk: "network-crawl", sourceUrl: "https://github.com/unclecode/crawl4ai", description: "Crawl and extract structured content from web pages." },
  { id: "fetch", name: "Fetch", category: "Web extraction", transport: "local-stdio", auth: [], risk: "network-fetch", sourceUrl: "https://github.com/modelcontextprotocol/servers", description: "Fetch web pages and extract readable content. Exact maintained implementation must be pinned during rollout." },
  { id: "postgresql", name: "PostgreSQL", category: "Database", transport: "local-stdio", auth: ["database-credentials"], risk: "database-write", sourceUrl: "https://github.com/modelcontextprotocol/servers", description: "Query a PostgreSQL database using a least-privilege database role." },
  { id: "sqlite", name: "SQLite", category: "Database", transport: "local-stdio", auth: ["database-file"], risk: "local-file-access", sourceUrl: "https://github.com/modelcontextprotocol/servers", description: "Inspect and query an explicitly approved SQLite database file." },
  { id: "neon", name: "Neon", category: "Database", transport: "remote-or-local", auth: ["oauth", "api-key"], risk: "hosted-database-write", sourceUrl: "https://github.com/neondatabase/mcp-server-neon", description: "Manage Neon projects, branches, and database resources." },
  { id: "context7", name: "Context7", category: "Documentation", transport: "remote-http", auth: ["oauth", "api-key"], endpoint: "https://mcp.context7.com/mcp", risk: "external-docs", sourceUrl: "https://github.com/upstash/context7", description: "Retrieve up-to-date library documentation for coding tasks." }
]);

const MCP_RISK_LABELS = Object.freeze({
  "write-access": "May write to repositories",
  "database-write": "Database access can change data",
  "browser-control": "Can control a browser",
  "external-search": "Sends searches to an external provider",
  "network-crawl": "Can crawl network-accessible pages",
  "network-fetch": "Can fetch network-accessible pages",
  "local-file-access": "Can access an approved local database file",
  "hosted-database-write": "Can change hosted database resources",
  "external-docs": "Sends documentation queries to an external provider"
});

function listMcpCatalog() {
  return MCP_CATALOG.map(entry => ({
    ...entry,
    auth: [...entry.auth],
    riskLabel: MCP_RISK_LABELS[entry.risk] || "Review permissions before enabling",
    state: "unconfigured"
  }));
}

function getMcpCatalogEntry(id) {
  const entry = MCP_CATALOG.find(item => item.id === id);
  return entry ? { ...entry, auth: [...entry.auth] } : null;
}

module.exports = { listMcpCatalog, getMcpCatalogEntry };
