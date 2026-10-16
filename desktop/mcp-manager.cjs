"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getMcpCatalogEntry, listMcpCatalog } = require("./mcp-catalog.cjs");

const SECRET_INTEGRATIONS = new Set(["brave-search", "crawl4ai", "postgresql", "sqlite"]);
const REQUIRED_SECRET_INTEGRATIONS = new Set(["brave-search", "postgresql", "sqlite"]);
const REMOTE_INTEGRATIONS = new Set(["github", "supabase", "context7", "neon", "exa"]);
const LOCAL_REVIEWED = new Set(["playwright", "postgresql", "sqlite", "fetch", "crawl4ai"]);
const MAX_SECRET_LENGTH = 16384;
const PINNED_PACKAGES = Object.freeze({
  playwright: "@playwright/mcp@0.0.83",
  postgresql: "@bytebase/dbhub@1.5.0",
  sqlite: "@bytebase/dbhub@1.5.0",
  "brave-search": "@brave/brave-search-mcp-server@2.1.4",
  crawl4ai: "crawl4ai-mcp-sse-stdio@1.1.0",
  fetch: "mcp-server-fetch==2026.7.10"
});
const REMOTE_ENDPOINTS = Object.freeze({
  github: "https://api.githubcopilot.com/mcp/",
  supabase: "https://mcp.supabase.com/mcp",
  context7: "https://mcp.context7.com/mcp",
  neon: "https://mcp.neon.tech/mcp",
  exa: "https://mcp.exa.ai/mcp"
});

function secureStorageAvailable(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) return false;
  try {
    const backend = typeof safeStorage.getSelectedStorageBackend === "function" ? safeStorage.getSelectedStorageBackend() : "";
    return backend !== "basic_text";
  } catch { return false; }
}

function isInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
}

function createMcpManager({ userDataPath, safeStorage } = {}) {
  const configPath = path.join(userDataPath, "mcp-integrations.json");

  function readRaw() {
    try {
      const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }
  function decryptSecret(record) {
    if (!record || typeof record.encryptedSecret !== "string" || !secureStorageAvailable(safeStorage)) return "";
    try { return safeStorage.decryptString(Buffer.from(record.encryptedSecret, "base64")); } catch { return ""; }
  }
  function writeRaw(raw) {
    fs.mkdirSync(userDataPath, { recursive: true });
    const tempPath = configPath + ".tmp";
    fs.writeFileSync(tempPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tempPath, 0o600); } catch {}
    fs.renameSync(tempPath, configPath);
    try { fs.chmodSync(configPath, 0o600); } catch {}
  }
  function getStatus() {
    const raw = readRaw();
    return listMcpCatalog().map(entry => {
      const saved = raw[entry.id] && typeof raw[entry.id] === "object" ? raw[entry.id] : {};
      const hasSecret = !!decryptSecret(saved);
      const canEnable = REMOTE_INTEGRATIONS.has(entry.id) || LOCAL_REVIEWED.has(entry.id) || (SECRET_INTEGRATIONS.has(entry.id) && hasSecret);
      const enabled = saved.enabled === true && canEnable;
      return {
        id: entry.id, name: entry.name, category: entry.category, transport: entry.transport,
        auth: entry.auth, risk: entry.risk, riskLabel: entry.riskLabel, sourceUrl: entry.sourceUrl,
        description: entry.description, endpoint: REMOTE_ENDPOINTS[entry.id] || entry.endpoint || null,
        state: enabled ? "configured" : hasSecret ? "configured" : "unconfigured",
        enabled, hasSecret, requiresRestart: enabled,
        package: PINNED_PACKAGES[entry.id] || entry.package || null,
        managed: REMOTE_INTEGRATIONS.has(entry.id) || LOCAL_REVIEWED.has(entry.id) || (SECRET_INTEGRATIONS.has(entry.id) && hasSecret),
        reviewNote: entry.id === "crawl4ai" ? "Requires a Crawl4AI API service at http://127.0.0.1:11235 by default; start the upstream service separately. Optional bearer token is encrypted." :
          entry.id === "fetch" ? "Uses the pinned official Python reference server via uvx; install uv/uvx first." : ""
      };
    });
  }
  function saveSecret(id, value) {
    if (!SECRET_INTEGRATIONS.has(id)) throw new Error("This integration does not accept a secret or connection value in this setup flow.");
    if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_SECRET_LENGTH) throw new Error("Enter a valid value (maximum 16384 characters).");
    if (id === "crawl4ai" && value.trim().length > 4096) throw new Error("Bearer token is too long.");
    if (id === "sqlite" && !path.isAbsolute(value.trim())) throw new Error("Choose an absolute SQLite database path.");
    if (id === "postgresql" && !/^postgres(?:ql)?:\/\//i.test(value.trim())) throw new Error("Enter a PostgreSQL connection URL beginning with postgres:// or postgresql://.");
    if (!secureStorageAvailable(safeStorage)) throw new Error("OS-backed secure storage is unavailable. Axiom will not save this value as plaintext.");
    const raw = readRaw(), previous = raw[id] && typeof raw[id] === "object" ? raw[id] : {};
    raw[id] = { ...previous, encryptedSecret: safeStorage.encryptString(value.trim()).toString("base64"), enabled: false };
    writeRaw(raw);
    return { id, saved: true, hasSecret: true, enabled: false, requiresRestart: false };
  }
  function setEnabled(id, enabled) {
    const entry = getMcpCatalogEntry(id);
    if (!entry) throw new Error("Unknown MCP integration.");
    if (typeof enabled !== "boolean") throw new Error("Enabled must be a boolean.");
    const supported = REMOTE_INTEGRATIONS.has(id) || LOCAL_REVIEWED.has(id) || SECRET_INTEGRATIONS.has(id);
    if (enabled && !supported) throw new Error(entry.id === "fetch" || entry.id === "crawl4ai"
      ? "This preset is withheld until a maintained, pinned MCP package passes publisher and runtime review."
      : "This integration's managed setup is not available yet.");
    const raw = readRaw(), previous = raw[id] && typeof raw[id] === "object" ? raw[id] : {};
    if (enabled && REQUIRED_SECRET_INTEGRATIONS.has(id) && !decryptSecret(previous)) throw new Error("Save the required credential or database path before enabling this integration.");
    raw[id] = { ...previous, enabled };
    writeRaw(raw);
    return { id, enabled, requiresRestart: true, status: enabled ? "configured" : "disabled" };
  }
  function remove(id) {
    if (!getMcpCatalogEntry(id)) throw new Error("Unknown MCP integration.");
    const raw = readRaw(); delete raw[id]; writeRaw(raw);
    return { id, removed: true, requiresRestart: true };
  }
  function openCodeEnvironment({ workspaceRoot } = {}) {
    const raw = readRaw(), mcp = {};
    for (const id of REMOTE_INTEGRATIONS) {
      const record = raw[id];
      if (!record || record.enabled !== true) continue;
      mcp[id] = { type: "remote", url: REMOTE_ENDPOINTS[id], enabled: true, timeout: 30000 };
    }
    for (const id of ["playwright", "postgresql", "sqlite"]) {
      const record = raw[id];
      if (!record || record.enabled !== true) continue;
      if (id === "playwright") {
        mcp.playwright = { type: "local", enabled: true, command: ["npx", "-y", PINNED_PACKAGES.playwright] };
      } else {
        const dsn = decryptSecret(record);
        if (!dsn) continue;
        if (id === "sqlite") {
          if (!workspaceRoot || !isInside(workspaceRoot, dsn)) continue;
          mcp.sqlite = { type: "local", enabled: true, command: ["npx", "-y", PINNED_PACKAGES.sqlite, "--transport", "stdio"], environment: { DSN: "sqlite://" + dsn } };
        } else {
          mcp.postgresql = { type: "local", enabled: true, command: ["npx", "-y", PINNED_PACKAGES.postgresql, "--transport", "stdio"], environment: { DSN: dsn, READONLY: "true" } };
        }
      }
    }
    for (const id of ["brave-search", "crawl4ai"]) {
      const record = raw[id];
      if (!record || record.enabled !== true) continue;
      const secret = decryptSecret(record);
      if (!secret) continue;
      if (id === "brave-search") mcp[id] = { type: "local", enabled: true, command: ["npx", "-y", PINNED_PACKAGES[id]], environment: { BRAVE_API_KEY: secret } };
      else mcp[id] = { type: "local", enabled: true, command: ["npx", "-y", PINNED_PACKAGES[id], "--stdio"], environment: { CRAWL4AI_ENDPOINT: "http://127.0.0.1:11235", ...(secret ? { CRAWL4AI_BEARER_TOKEN: secret } : {}) } };
    }
    if (raw.fetch?.enabled === true) mcp.fetch = { type: "local", enabled: true, command: ["uvx", "--from", "mcp-server-fetch==2026.7.10", "mcp-server-fetch"] };
    return Object.keys(mcp).length ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) } : {};
  }
  return Object.freeze({ getStatus, saveSecret, setEnabled, remove, openCodeEnvironment, configPath });
}

module.exports = { createMcpManager, secureStorageAvailable, isInside, PINNED_PACKAGES, REMOTE_ENDPOINTS };
