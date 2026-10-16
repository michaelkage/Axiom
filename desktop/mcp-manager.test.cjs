"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMcpManager, secureStorageAvailable } = require("./mcp-manager.cjs");

function storage() {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test-keychain",
    encryptString: value => Buffer.from("cipher:" + value),
    decryptString: value => value.toString().replace(/^cipher:/, "")
  };
}

function setup(safeStorage = storage()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-mcp-"));
  return { dir, manager: createMcpManager({ userDataPath: dir, safeStorage, platform: "linux" }) };
}

test("credential storage refuses plaintext fallback", () => {
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" }), false);
  const { dir, manager } = setup({ isEncryptionAvailable: () => false });
  try {
    assert.throws(() => manager.saveSecret("brave-search", "secret"), /will not save this credential as plaintext/);
    assert.equal(fs.existsSync(manager.configPath), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("secret credentials are encrypted at rest and never returned in status", () => {
  const { dir, manager } = setup();
  try {
    const saved = manager.saveSecret("brave-search", "test-secret-value");
    assert.deepEqual(saved, { id: "brave-search", saved: true, hasSecret: true, enabled: false, requiresRestart: false });
    const disk = fs.readFileSync(manager.configPath, "utf8");
    assert.equal(disk.includes("test-secret-value"), false);
    assert.equal(manager.getStatus().find(item => item.id === "brave-search").hasSecret, true);
    assert.equal(JSON.stringify(manager.getStatus()).includes("test-secret-value"), false);
    assert.equal(manager.openCodeEnvironment().OPENCODE_CONFIG_CONTENT, undefined);
    manager.setEnabled("brave-search", true);
    const config = JSON.parse(manager.openCodeEnvironment().OPENCODE_CONFIG_CONTENT);
    assert.equal(config.mcp["brave-search"].environment.BRAVE_API_KEY, "test-secret-value");
    assert.equal(config.mcp["brave-search"].type, "local");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("remote OAuth presets create only reviewed HTTPS endpoints", () => {
  const { dir, manager } = setup();
  try {
    assert.deepEqual(manager.setEnabled("context7", true), { id: "context7", enabled: true, requiresRestart: true, status: "configured" });
    const config = JSON.parse(manager.openCodeEnvironment().OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.mcp.context7, { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true });
    assert.equal(config.mcp.supabase, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("refuses unsupported presets, missing secrets, and unknown IDs", () => {
  const { dir, manager } = setup();
  try {
    assert.throws(() => manager.setEnabled("playwright", true), /managed installer and configuration flow is not available/);
    assert.throws(() => manager.setEnabled("exa", true), /Save the provider API key/);
    assert.throws(() => manager.setEnabled("made-up", true), /Unknown MCP integration/);
    assert.deepEqual(manager.remove("context7"), { id: "context7", removed: true, requiresRestart: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
