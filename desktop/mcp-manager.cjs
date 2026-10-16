"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { getMcpCatalogEntry, listMcpCatalog } = require("./mcp-catalog.cjs");

const SECRET_INTEGRATIONS = new Set(["brave-search", "exa"]);
const REMOTE_INTEGRATIONS = new Set(["supabase", "context7"]);
const MAX_SECRET_LENGTH = 8192;

function secureStorageAvailable(safeStorage) {
  if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) return false;
  try {
    const backend = typeof safeStorage.getSelectedStorageBackend === "function" ? safeStorage.getSelectedStorageBackend() : "";
    return backend !== "basic_text";
  } catch { return false; }
}

function createMcpManager({ userDataPath, safeStorage, platform = process.platform } = {}) {
  const configPath = path.join(userDataPath, "mcp-integrations.json");

  function readRaw() {
    try {
      const value = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function decryptSecret(record) {
    if (!record || typeof record.encryptedSecret !== "string") return "";
    if (!secureStorageAvailable(safeStorage)) return "";
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
      const enabled = saved.enabled === true && (
        REMOTE_INTEGRATIONS.has(entry.id) ||
        (SECRET_INTEGRATIONS.has(entry.id) && hasSecret)
      );
      return {
        id: entry.id, name: entry.name, category: entry.category, transport: entry.transport,
        auth: entry.auth, risk: entry.risk, riskLabel: entry.riskLabel, sourceUrl: entry.sourceUrl,
        description: entry.description, endpoint: entry.endpoint || null,
        state: enabled ? "configured" : hasSecret ? "configured" : "unconfigured",
        enabled, hasSecret, requiresRestart: enabled
      };
    });
  }

  function saveSecret(id, value) {
    const entry = getMcpCatalogEntry(id);
    if (!entry || !SECRET_INTEGRATIONS.has(id)) throw new Error("This integration does not support credential entry in this setup flow.");
    if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_SECRET_LENGTH) {
      throw new Error("Enter a valid credential (maximum 8192 characters).");
    }
    if (!secureStorageAvailable(safeStorage)) {
      throw new Error("OS-backed secure storage is unavailable. Axiom will not save this credential as plaintext.");
    }
    const raw = readRaw();
    const previous = raw[id] && typeof raw[id] === "object" ? raw[id] : {};
    raw[id] = { ...previous, encryptedSecret: safeStorage.encryptString(value.trim()).toString("base64"), enabled: false };
    writeRaw(raw);
    return { id, saved: true, hasSecret: true, enabled: false, requiresRestart: false };
  }

  function setEnabled(id, enabled) {
    const entry = getMcpCatalogEntry(id);
    if (!entry) throw new Error("Unknown MCP integration.");
    if (enabled !== true && enabled !== false) throw new Error("Enabled must be a boolean.");
    if (enabled && !REMOTE_INTEGRATIONS.has(id) && !SECRET_INTEGRATIONS.has(id)) {
      throw new Error("This integration's managed installer and configuration flow is not available yet.");
    }
    const raw = readRaw();
    const previous = raw[id] && typeof raw[id] === "object" ? raw[id] : {};
    if (enabled && SECRET_INTEGRATIONS.has(id) && !decryptSecret(previous)) {
      throw new Error("Save the provider API key before enabling this integration.");
    }
    raw[id] = { ...previous, enabled };
    writeRaw(raw);
    return { id, enabled, requiresRestart: true, status: enabled ? "configured" : "disabled" };
  }

  function remove(id) {
    if (!getMcpCatalogEntry(id)) throw new Error("Unknown MCP integration.");
    const raw = readRaw();
    delete raw[id];
    writeRaw(raw);
    return { id, removed: true, requiresRestart: true };
  }

  function openCodeEnvironment() {
    const raw = readRaw();
    const mcp = {};
    for (const id of REMOTE_INTEGRATIONS) {
      const record = raw[id];
      if (!record || record.enabled !== true) continue;
      const entry = getMcpCatalogEntry(id);
      if (!entry || !entry.endpoint) continue;
      mcp[id] = { type: "remote", url: entry.endpoint, enabled: true };
    }
    for (const id of SECRET_INTEGRATIONS) {
      const record = raw[id];
      if (!record || record.enabled !== true) continue;
      const secret = decryptSecret(record);
      if (!secret) continue;
      if (id === "brave-search") {
        mcp[id] = {
          type: "local", enabled: true, command: ["npx", "-y", "@brave/brave-search-mcp-server"],
          environment: { BRAVE_API_KEY: secret }
        };
      } else if (id === "exa") {
        mcp[id] = {
          type: "local", enabled: true, command: ["npx", "-y", "exa-mcp-server"],
          environment: { EXA_API_KEY: secret }
        };
      }
    }
    return Object.keys(mcp).length ? { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) } : {};
  }

  return Object.freeze({ getStatus, saveSecret, setEnabled, remove, openCodeEnvironment, configPath });
}

module.exports = { createMcpManager, secureStorageAvailable };
