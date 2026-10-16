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
  return { dir, manager: createMcpManager({ userDataPath: dir, safeStorage }) };
}

test("credential storage refuses plaintext fallback", () => {
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" }), false);
  const { dir, manager } = setup({ isEncryptionAvailable: () => false });
  try {
    assert.throws(() => manager.saveSecret("brave-search", "secret"), /will not save this value as plaintext/);
    assert.equal(fs.existsSync(manager.configPath), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("secret values are encrypted at rest and never returned in status", () => {
  const { dir, manager } = setup();
  try {
    manager.saveSecret("brave-search", "test-secret-value");
    const disk = fs.readFileSync(manager.configPath, "utf8");
    assert.equal(disk.includes("test-secret-value"), false);
    assert.equal(manager.getStatus().find(item => item.id === "brave-search").hasSecret, true);
    assert.equal(JSON.stringify(manager.getStatus()).includes("test-secret-value"), false);
    manager.setEnabled("brave-search", true);
    const config = JSON.parse(manager.openCodeEnvironment().OPENCODE_CONFIG_CONTENT);
    assert.equal(config.mcp["brave-search"].environment.BRAVE_API_KEY, "test-secret-value");
    assert.equal(config.mcp["brave-search"].type, "local");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reviewed remote endpoints use OpenCode remote transport and OAuth defaults", () => {
  const { dir, manager } = setup();
  try {
    manager.setEnabled("context7", true);
    manager.setEnabled("supabase", true);
    manager.setEnabled("github", true);
    manager.setEnabled("neon", true);
    const config = JSON.parse(manager.openCodeEnvironment().OPENCODE_CONFIG_CONTENT);
    assert.deepEqual(config.mcp.context7, { type: "remote", url: "https://mcp.context7.com/mcp", enabled: true, timeout: 30000 });
    assert.equal(config.mcp.supabase.url, "https://mcp.supabase.com/mcp");
    assert.equal(config.mcp.github.url, "https://api.githubcopilot.com/mcp/");
    assert.equal(config.mcp.neon.url, "https://mcp.neon.tech/mcp");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("Playwright uses a pinned package and database credentials are secure", () => {
  const { dir, manager } = setup();
  try {
    manager.setEnabled("playwright", true);
    const root = path.join(dir, "workspace"); fs.mkdirSync(root);
    const sqliteFile = path.join(root, "test.db");
    manager.saveSecret("sqlite", sqliteFile);
    manager.setEnabled("sqlite", true);
    manager.saveSecret("postgresql", "postgresql://readonly:secret@localhost:5432/app");
    manager.setEnabled("postgresql", true);
    const config = JSON.parse(manager.openCodeEnvironment({ workspaceRoot: root }).OPENCODE_CONFIG_CONTENT);
    assert.equal(config.mcp.playwright.command[2], "@playwright/mcp@0.0.83");
    assert.equal(config.mcp.sqlite.command[2], "@bytebase/dbhub@1.5.0");
    assert.equal(config.mcp.postgresql.environment.DSN, "postgresql://readonly:secret@localhost:5432/app");
    assert.equal(config.mcp.postgresql.environment.READ_ONLY, "true");
    assert.equal(manager.openCodeEnvironment({ workspaceRoot: dir }).OPENCODE_CONFIG_CONTENT.includes('"sqlite"'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("withholds Fetch and Crawl4AI until reviewed package metadata exists", () => {
  const { dir, manager } = setup();
  try {
    assert.throws(() => manager.setEnabled("fetch", true), /maintained, pinned MCP package passes/);
    assert.throws(() => manager.setEnabled("crawl4ai", true), /maintained, pinned MCP package passes/);
    assert.throws(() => manager.setEnabled("made-up", true), /Unknown MCP integration/);
    assert.deepEqual(manager.remove("context7"), { id: "context7", removed: true, requiresRestart: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
