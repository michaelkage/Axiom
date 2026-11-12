"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createSecureStorage } = require("./secure-storage.cjs");

function fixture() {
  const userDataPath = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-secure-storage-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "keychain",
    encryptString: value => Buffer.from("encrypted:" + value, "utf8"),
    decryptString: value => {
      const text = value.toString("utf8");
      if (!text.startsWith("encrypted:")) throw new Error("Invalid ciphertext");
      return text.slice(10);
    }
  };
  return { userDataPath, safeStorage, storage: createSecureStorage({ userDataPath, safeStorage }) };
}

test("secure storage encrypts values at rest and reads them by namespace", () => {
  const { userDataPath, storage } = fixture();
  storage.set("github", "pat", "ghp-secret-value");
  const raw = fs.readFileSync(path.join(userDataPath, "secure-credentials.json"), "utf8");
  assert.equal(raw.includes("ghp-secret-value"), false);
  assert.equal(storage.get("github", "pat"), "ghp-secret-value");
});

test("secure storage isolates namespaces and removes credentials", () => {
  const { storage } = fixture();
  storage.set("github", "token", "github-value");
  storage.set("supabase", "token", "supabase-value");
  assert.equal(storage.clearNamespace("github"), 1);
  assert.equal(storage.get("github", "token"), null);
  assert.equal(storage.get("supabase", "token"), "supabase-value");
  assert.equal(storage.remove("supabase", "token"), true);
  assert.equal(storage.remove("supabase", "token"), false);
});

test("secure storage rejects insecure backend and malformed keys", () => {
  const { userDataPath, safeStorage } = fixture();
  const insecure = createSecureStorage({ userDataPath, safeStorage: { ...safeStorage, getSelectedStorageBackend: () => "basic_text" } });
  assert.throws(() => insecure.set("github", "pat", "secret"), /not secure/);
  const storage = createSecureStorage({ userDataPath, safeStorage });
  assert.throws(() => storage.set("../github", "pat", "secret"), /Invalid credential namespace/);
  assert.throws(() => storage.set("github", "pat", "x".repeat(65537)), /64 KiB/);
});
