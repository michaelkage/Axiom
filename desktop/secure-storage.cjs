"use strict";

const fs = require("node:fs");
const path = require("node:path");

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const MAX_SECRET_BYTES = 64 * 1024;

function createSecureStorage({ userDataPath, safeStorage, fsImpl = fs }) {
  if (typeof userDataPath !== "string" || !userDataPath) throw new Error("A secure storage directory is required.");
  const filePath = path.join(userDataPath, "secure-credentials.json");

  function assertAvailable() {
    if (!safeStorage || typeof safeStorage.isEncryptionAvailable !== "function" || !safeStorage.isEncryptionAvailable()) {
      throw new Error("OS-backed credential encryption is unavailable on this device.");
    }
    if (typeof safeStorage.getSelectedStorageBackend === "function" && safeStorage.getSelectedStorageBackend() === "basic_text") {
      throw new Error("The selected credential backend is not secure. Axiom will not store credentials in plaintext.");
    }
  }

  function validateName(value, label) {
    if (typeof value !== "string" || !NAME_PATTERN.test(value)) throw new Error("Invalid credential " + label + ".");
    return value;
  }

  function read() {
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(filePath, "utf8"));
      if (parsed.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
        throw new Error("Credential store has an unsupported format.");
      }
      return parsed;
    } catch (error) {
      if (error && error.code === "ENOENT") return { schemaVersion: 1, entries: {} };
      throw error;
    }
  }

  function write(store) {
    fsImpl.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const temporary = filePath + "." + process.pid + ".tmp";
    try {
      fsImpl.writeFileSync(temporary, JSON.stringify(store), { encoding: "utf8", mode: 0o600, flag: "wx" });
      fsImpl.renameSync(temporary, filePath);
    } catch (error) {
      try { fsImpl.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function set(namespace, key, value) {
    assertAvailable();
    validateName(namespace, "namespace");
    validateName(key, "key");
    if (typeof value !== "string") throw new Error("Credential values must be strings.");
    if (Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES) throw new Error("Credential value exceeds 64 KiB.");
    const store = read();
    const encrypted = safeStorage.encryptString(value);
    store.entries[namespace + ":" + key] = encrypted.toString("base64");
    write(store);
    return { stored: true };
  }

  function get(namespace, key) {
    assertAvailable();
    validateName(namespace, "namespace");
    validateName(key, "key");
    const encoded = read().entries[namespace + ":" + key];
    if (typeof encoded !== "string") return null;
    try { return safeStorage.decryptString(Buffer.from(encoded, "base64")); }
    catch { throw new Error("Credential could not be decrypted. It may have been created by another OS account."); }
  }

  function remove(namespace, key) {
    assertAvailable();
    validateName(namespace, "namespace");
    validateName(key, "key");
    const store = read();
    const id = namespace + ":" + key;
    if (!Object.hasOwn(store.entries, id)) return false;
    delete store.entries[id];
    write(store);
    return true;
  }

  function clearNamespace(namespace) {
    assertAvailable();
    validateName(namespace, "namespace");
    const store = read();
    const prefix = namespace + ":";
    let removed = 0;
    for (const key of Object.keys(store.entries)) {
      if (key.startsWith(prefix)) { delete store.entries[key]; removed += 1; }
    }
    if (removed) write(store);
    return removed;
  }

  return Object.freeze({ get, set, remove, clearNamespace });
}

module.exports = { createSecureStorage, MAX_SECRET_BYTES };
