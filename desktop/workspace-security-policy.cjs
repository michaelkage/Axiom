"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const POLICY_SCHEMA_VERSION = 1;
const POLICY_ACTIONS = Object.freeze({
  "filesystem.read": Object.freeze(["allow", "deny"]),
  "filesystem.write": Object.freeze(["approval-required", "deny"]),
  "shell.execute": Object.freeze(["approval-required", "deny"]),
  "network.request": Object.freeze(["approval-required", "deny"]),
  "mcp.invoke": Object.freeze(["approval-required", "deny"]),
  "git.push": Object.freeze(["approval-required", "deny"]),
  "deployment.publish": Object.freeze(["approval-required", "deny"]),
  "plugin.execute": Object.freeze(["approval-required", "deny"])
});
const DEFAULT_POLICY = Object.freeze({
  "filesystem.read": "allow",
  "filesystem.write": "approval-required",
  "shell.execute": "approval-required",
  "network.request": "deny",
  "mcp.invoke": "deny",
  "git.push": "approval-required",
  "deployment.publish": "approval-required",
  "plugin.execute": "approval-required"
});
const MAX_POLICY_BYTES = 32 * 1024;

function workspaceIdentity(workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) throw new TypeError("An absolute workspace root is required.");
  const canonical = path.resolve(workspaceRoot);
  return {
    root: canonical,
    id: crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 40)
  };
}

function validatePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new TypeError("Security policy must be an object.");
  const keys = Object.keys(policy);
  if (keys.length !== Object.keys(POLICY_ACTIONS).length || keys.some(key => !Object.prototype.hasOwnProperty.call(POLICY_ACTIONS, key))) {
    throw new Error("Security policy must define every supported action exactly once.");
  }
  const normalized = {};
  for (const [action, allowed] of Object.entries(POLICY_ACTIONS)) {
    if (!allowed.includes(policy[action])) throw new Error("Unsupported decision for security action: " + action);
    normalized[action] = policy[action];
  }
  return normalized;
}

function createWorkspaceSecurityPolicyStore({ userDataPath, fsImpl = fs }) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("An absolute user-data directory is required.");
  const policyRoot = path.join(path.resolve(userDataPath), "security-policies");

  function pathsFor(workspaceRoot) {
    const identity = workspaceIdentity(workspaceRoot);
    return { ...identity, file: path.join(policyRoot, identity.id + ".json") };
  }

  function defaultRecord(identity) {
    return {
      schemaVersion: POLICY_SCHEMA_VERSION,
      workspaceId: identity.id,
      workspaceRoot: identity.root,
      revision: 0,
      updatedAt: null,
      policy: { ...DEFAULT_POLICY }
    };
  }

  function validateRecord(record, identity) {
    if (!record || typeof record !== "object" || Array.isArray(record) ||
        record.schemaVersion !== POLICY_SCHEMA_VERSION ||
        record.workspaceId !== identity.id ||
        record.workspaceRoot !== identity.root ||
        !Number.isSafeInteger(record.revision) || record.revision < 0 ||
        !(record.updatedAt === null || (typeof record.updatedAt === "string" && !Number.isNaN(Date.parse(record.updatedAt))))) {
      throw new Error("Persisted security policy is invalid or belongs to another workspace.");
    }
    return {
      schemaVersion: POLICY_SCHEMA_VERSION,
      workspaceId: identity.id,
      workspaceRoot: identity.root,
      revision: record.revision,
      updatedAt: record.updatedAt,
      policy: validatePolicy(record.policy)
    };
  }

  function read(workspaceRoot) {
    const identity = pathsFor(workspaceRoot);
    let stat;
    try {
      stat = fsImpl.lstatSync(identity.file);
    } catch (error) {
      if (error.code === "ENOENT") return defaultRecord(identity);
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_POLICY_BYTES) {
      throw new Error("Persisted security policy file is unsafe or oversized.");
    }
    const descriptor = fsImpl.openSync(identity.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let raw;
    try { raw = fsImpl.readFileSync(descriptor, "utf8"); }
    finally { fsImpl.closeSync(descriptor); }
    return validateRecord(JSON.parse(raw), identity);
  }

  function update(workspaceRoot, nextPolicy, expectedRevision) {
    const identity = pathsFor(workspaceRoot);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new TypeError("A valid expected policy revision is required.");
    const current = read(workspaceRoot);
    if (current.revision !== expectedRevision) {
      const error = new Error("Security policy changed in another operation; reload before updating.");
      error.code = "POLICY_REVISION_CONFLICT";
      throw error;
    }
    const record = {
      schemaVersion: POLICY_SCHEMA_VERSION,
      workspaceId: identity.id,
      workspaceRoot: identity.root,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      policy: validatePolicy(nextPolicy)
    };
    fsImpl.mkdirSync(policyRoot, { recursive: true, mode: 0o700 });
    const rootStat = fsImpl.lstatSync(policyRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Security policy directory is unsafe.");
    const temporary = identity.file + "." + crypto.randomUUID() + ".tmp";
    let descriptor;
    try {
      descriptor = fsImpl.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600);
      fsImpl.writeFileSync(descriptor, JSON.stringify(record, null, 2) + "\n", "utf8");
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      fsImpl.renameSync(temporary, identity.file);
      try {
        const directory = fsImpl.openSync(policyRoot, fs.constants.O_RDONLY);
        try { fsImpl.fsyncSync(directory); } finally { fsImpl.closeSync(directory); }
      } catch { /* Directory fsync is unavailable on some supported filesystems. */ }
    } catch (error) {
      if (descriptor !== undefined) fsImpl.closeSync(descriptor);
      try { fsImpl.unlinkSync(temporary); } catch {}
      throw error;
    }
    return record;
  }

  function evaluate(workspaceRoot, action) {
    if (!Object.prototype.hasOwnProperty.call(POLICY_ACTIONS, action)) return { decision: "deny", reason: "Unknown security action." };
    let record;
    try { record = read(workspaceRoot); }
    catch (error) { return { decision: "deny", reason: "Security policy could not be loaded safely: " + String(error.message || error).slice(0, 300) }; }
    const decision = record.policy[action];
    return {
      decision,
      reason: decision === "allow" ? "Allowed by the persisted workspace security policy." :
        decision === "approval-required" ? "The persisted workspace security policy requires native approval." :
          "Denied by the persisted workspace security policy.",
      revision: record.revision
    };
  }

  return Object.freeze({ read, update, evaluate });
}

module.exports = {
  POLICY_SCHEMA_VERSION,
  POLICY_ACTIONS,
  DEFAULT_POLICY,
  MAX_POLICY_BYTES,
  workspaceIdentity,
  validatePolicy,
  createWorkspaceSecurityPolicyStore
};
