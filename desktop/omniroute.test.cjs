"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeBaseUrl, isLoopback, createOmniRouteManager, secureStorageAvailable } = require("./omniroute.cjs");

test("normalizes API base URLs and rejects embedded credentials", () => {
  assert.equal(normalizeBaseUrl("http://127.0.0.1:20128/v1/"), "http://127.0.0.1:20128/v1");
  assert.throws(() => normalizeBaseUrl("http://user:secret@localhost/v1"), /cannot contain credentials/);
  assert.throws(() => normalizeBaseUrl("file:///tmp/api"), /HTTP/);
});

test("recognizes loopback router endpoints without treating remote hosts as local", () => {
  assert.equal(isLoopback("http://localhost:20128/v1"), true);
  assert.equal(isLoopback("http://127.0.0.1:20128/v1"), true);
  assert.equal(isLoopback("https://api.example.com/v1"), false);
});

test("refuses insecure Linux basic_text credential storage", () => {
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text" }), false);
  assert.equal(secureStorageAvailable({ isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret" }), true);
});

test("saves router preferences and produces an isolated OpenCode provider override", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-omniroute-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "win32",
    encryptString: value => Buffer.from("encrypted:" + value),
    decryptString: value => value.toString().replace(/^encrypted:/, "")
  };
  try {
    const manager = createOmniRouteManager({
      userDataPath: dir, safeStorage, platform: "linux",
      fetchImpl: async () => new Response(JSON.stringify({ data: [{ id: "auto", name: "Auto" }] }), { status: 200 }),
      spawnProcess: () => { throw new Error("Unexpected process launch in this test."); }
    });
    const saved = await manager.save({
      baseUrl: "http://127.0.0.1:20128/v1", model: "auto", enabled: true,
      autoStart: false, apiKey: "test-router-key"
    });
    assert.equal(saved.requiresRestart, true);
    assert.equal(manager.getConfig().hasApiKey, true);
    const env = JSON.parse(manager.openCodeEnvironment().OPENCODE_CONFIG_CONTENT);
    assert.equal(env.model, "omniroute/auto");
    assert.equal(env.provider.omniroute.options.baseURL, "http://127.0.0.1:20128/v1");
    assert.equal(env.provider.omniroute.options.apiKey, "test-router-key");
    const status = await manager.status();
    assert.equal(status.endpoint.reachable, true);
    assert.deepEqual(status.endpoint.models.map(item => item.id), ["auto"]);
    assert.equal(fs.existsSync(path.join(dir, "omniroute-settings.json")), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("does not allow auto-start for remote or non-default local endpoints", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-omniroute-"));
  try {
    const manager = createOmniRouteManager({ userDataPath: dir, safeStorage: { isEncryptionAvailable: () => false } });
    await assert.rejects(manager.save({ baseUrl: "https://router.example/v1", enabled: true, autoStart: true }), /only supported for the local OmniRoute/);
    await assert.rejects(manager.save({ baseUrl: "http://127.0.0.1:29999/v1", enabled: true, autoStart: true }), /only supported for the local OmniRoute/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
