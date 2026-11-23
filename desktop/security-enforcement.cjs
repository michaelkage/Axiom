"use strict";

const path = require("node:path");
const crypto = require("node:crypto");
const fsConstants = require("node:fs").constants;

const MAX_AUDIT_BYTES = 5 * 1024 * 1024;
const MAX_AUDIT_EVENTS = 4000;

const BLOCKED = new Set([".git", "node_modules", ".axiom", "dist", "out", ".next", ".env", ".env.local", ".env.production", ".ssh", ".aws", ".azure", ".gnupg", ".kube", ".docker", ".npmrc", ".pypirc", ".netrc", ".git-credentials", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "id_ed25519_sk", "id_ecdsa_sk"]);

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new TypeError("A workspace-relative path is required.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) throw new Error("Absolute paths are denied by project security policy.");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === ".." || segment.includes("\0"))) throw new Error("Path traversal is denied by project security policy.");
  if (segments.some(segment => { const name = segment.toLowerCase(); return BLOCKED.has(name) || name.startsWith(".env.") || /\.(?:pem|key|p12|pfx|keystore)$/.test(name); })) throw new Error("This path is denied by project security policy.");
  return segments.join("/");
}

function combineFilesystemDecisions(baseEvaluation, policyEvaluation) {
  const valid = value => value && ["allow", "approval-required", "deny"].includes(value.decision);
  if (!valid(baseEvaluation) || !valid(policyEvaluation)) {
    return { decision: "deny", reason: "A filesystem authorization layer returned an invalid decision." };
  }
  if (baseEvaluation.decision === "deny") return baseEvaluation;
  if (policyEvaluation.decision === "deny") return policyEvaluation;
  if (baseEvaluation.decision === "approval-required" || policyEvaluation.decision === "approval-required") {
    return {
      decision: "approval-required",
      reason: policyEvaluation.decision === "approval-required" ? policyEvaluation.reason : baseEvaluation.reason
    };
  }
  return { decision: "allow", reason: policyEvaluation.reason || baseEvaluation.reason };
}

function evaluateFilesystemAccess({ workspaceRoot, relativePath, operation }) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) return { decision: "deny", reason: "No trusted workspace is selected." };
  if (!["read", "write"].includes(operation)) return { decision: "deny", reason: "Unknown filesystem operation." };
  let relative;
  try { relative = normalizeRelativePath(relativePath); }
  catch (error) { return { decision: "deny", reason: error.message }; }
  if (operation === "write" && !relative) return { decision: "deny", reason: "A project file path is required for writes." };
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, ...relative.split("/").filter(Boolean));
  if (target !== root && !target.startsWith(root + path.sep)) return { decision: "deny", reason: "Filesystem target escapes the selected workspace." };
  if (operation === "write") return { decision: "approval-required", reason: "Project file modifications require explicit native confirmation." };
  return { decision: "allow", reason: "Read is confined to a safe workspace-relative path." };
}

function createSecurityAuditStore({ userDataPath, integrityKey, getAnchor = () => null, setAnchor = () => {}, fsImpl = require("node:fs") }) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("A user-data directory is required.");
  if (typeof integrityKey !== "string" || !/^[a-f0-9]{64}$/i.test(integrityKey)) throw new TypeError("A 256-bit OS-protected audit integrity key is required.");
  if (typeof getAnchor !== "function" || typeof setAnchor !== "function") throw new TypeError("Audit anchor callbacks are required.");
  const file = path.join(userDataPath, "security-audit.jsonl");
  const genesis = "0".repeat(64);

  function canonicalEvent(event) {
    return JSON.stringify({
      schemaVersion: event.schemaVersion,
      sequence: event.sequence,
      timestamp: event.timestamp,
      action: event.action,
      decision: event.decision,
      reason: event.reason,
      projectId: event.projectId,
      resource: event.resource,
      actor: event.actor,
      previousHash: event.previousHash,
      legacyUnverified: event.legacyUnverified === true
    });
  }
  function digest(event) {
    return crypto.createHmac("sha256", Buffer.from(integrityKey, "hex")).update(canonicalEvent(event)).digest("hex");
  }
  function readRaw() {
    const descriptor = fsImpl.openSync(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    try { return fsImpl.readFileSync(descriptor, "utf8"); }
    finally { fsImpl.closeSync(descriptor); }
  }
  function parseAndVerify(raw) {
    const lines = raw.split("\n").filter(Boolean);
    if (lines.length > MAX_AUDIT_EVENTS) throw new Error("Security audit exceeded its retained event limit; privileged operations are blocked.");
    let previousHash = genesis;
    let sequence = 0;
    const events = [];
    for (const line of lines) {
      let event;
      try { event = JSON.parse(line); } catch { throw new Error("Security audit integrity verification failed: malformed event."); }
      if (!event || event.schemaVersion !== 2 || event.sequence !== sequence + 1 ||
          event.previousHash !== previousHash || typeof event.hash !== "string" ||
          !/^[a-f0-9]{64}$/i.test(event.hash) ||
          !crypto.timingSafeEqual(Buffer.from(event.hash, "hex"), Buffer.from(digest(event), "hex"))) {
        throw new Error("Security audit integrity verification failed; privileged operations are blocked.");
      }
      previousHash = event.hash;
      sequence = event.sequence;
      events.push(event);
    }
    return { events, sequence, hash: previousHash };
  }
  function atomicWrite(raw) {
    const temporary = file + "." + crypto.randomUUID() + ".tmp";
    let descriptor;
    try {
      descriptor = fsImpl.openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
      fsImpl.writeFileSync(descriptor, raw, "utf8");
      fsImpl.fsyncSync(descriptor);
      fsImpl.closeSync(descriptor);
      descriptor = undefined;
      fsImpl.renameSync(temporary, file);
    } catch (error) {
      if (descriptor !== undefined) fsImpl.closeSync(descriptor);
      try { fsImpl.unlinkSync(temporary); } catch {}
      throw error;
    }
  }
  function readVerified() {
    let raw;
    try {
      const stat = fsImpl.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_AUDIT_BYTES) throw new Error("Security audit path is unsafe or oversized.");
      raw = readRaw();
    } catch (error) {
      if (error.code === "ENOENT") {
        const anchor = getAnchor();
        if (anchor) throw new Error("Security audit log is missing but its protected integrity anchor exists.");
        return { events: [], sequence: 0, hash: genesis };
      }
      throw error;
    }
    let anchor = getAnchor();
    if (!anchor) {
      const legacyLines = raw.split("\\n").filter(Boolean);
      if (legacyLines.length) {
        let previousHash = genesis;
        const migrated = legacyLines.map((line, index) => {
          let legacy;
          try { legacy = JSON.parse(line); } catch { throw new Error("Legacy security audit contains malformed data; migration refused."); }
          if (!legacy || legacy.schemaVersion !== 1 || typeof legacy.timestamp !== "string" ||
              typeof legacy.action !== "string" || !["allow", "deny", "approval-required"].includes(legacy.decision) ||
              typeof legacy.reason !== "string") throw new Error("Legacy security audit contains an invalid event; migration refused.");
          const event = {
            schemaVersion: 2, sequence: index + 1, timestamp: legacy.timestamp,
            action: legacy.action.slice(0, 80), decision: legacy.decision,
            reason: legacy.reason.slice(0, 500),
            projectId: typeof legacy.projectId === "string" ? legacy.projectId.slice(0, 128) : null,
            resource: typeof legacy.resource === "string" ? legacy.resource.slice(0, 512) : null,
            actor: typeof legacy.actor === "string" ? legacy.actor.slice(0, 80) : "desktop-main",
            previousHash, legacyUnverified: true
          };
          event.hash = digest(event);
          previousHash = event.hash;
          return event;
        });
        const migratedRaw = migrated.map(event => JSON.stringify(event)).join("\\n") + "\\n";
        if (Buffer.byteLength(migratedRaw, "utf8") > MAX_AUDIT_BYTES || migrated.length > MAX_AUDIT_EVENTS) {
          throw new Error("Legacy security audit exceeds migration limits; privileged operations are blocked.");
        }
        atomicWrite(migratedRaw);
        anchor = { sequence: migrated.length, hash: previousHash };
        setAnchor(anchor);
        return { events: migrated, sequence: migrated.length, hash: previousHash };
      }
      return { events: [], sequence: 0, hash: genesis };
    }
    const verified = parseAndVerify(raw);
    if (!Number.isSafeInteger(anchor.sequence) || typeof anchor.hash !== "string" ||
        anchor.sequence !== verified.sequence || anchor.hash !== verified.hash) {
      throw new Error("Security audit head does not match its OS-protected integrity anchor.");
    }
    return verified;
  }
  function record(input) {
    fsImpl.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    const current = readVerified();
    if (current.sequence >= MAX_AUDIT_EVENTS) throw new Error("Security audit retention limit reached; export or archive the audit before further privileged operations.");
    const event = {
      schemaVersion: 2,
      sequence: current.sequence + 1,
      timestamp: new Date().toISOString(),
      action: String(input.action || "unknown").slice(0, 80),
      decision: ["allow", "deny", "approval-required"].includes(input.decision) ? input.decision : "deny",
      reason: String(input.reason || "").slice(0, 500),
      projectId: typeof input.projectId === "string" ? input.projectId.slice(0, 128) : null,
      resource: typeof input.resource === "string" ? input.resource.slice(0, 512) : null,
      actor: "desktop-main",
      previousHash: current.hash,
      legacyUnverified: false
    };
    event.hash = digest(event);
    const serialized = JSON.stringify(event) + "\\n";
    let existingBytes = 0;
    try { existingBytes = fsImpl.statSync(file).size; } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (existingBytes + Buffer.byteLength(serialized, "utf8") > MAX_AUDIT_BYTES) {
      throw new Error("Security audit size limit reached; export or archive the audit before further privileged operations.");
    }
    const descriptor = fsImpl.openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | (fsConstants.O_NOFOLLOW || 0), 0o600);
    try {
      fsImpl.appendFileSync(descriptor, JSON.stringify(event) + "\n", { encoding: "utf8" });
      fsImpl.fsyncSync(descriptor);
    } finally { fsImpl.closeSync(descriptor); }
    // The OS-protected anchor is updated after the durable append. If this fails,
    // the mismatch makes subsequent privileged operations fail closed.
    setAnchor({ sequence: event.sequence, hash: event.hash });
    return event;
  }
  function list(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Audit limit must be between 1 and 1000.");
    return readVerified().events.slice(-limit);
  }
  return Object.freeze({ record, list, verify: () => readVerified().sequence });
}

module.exports = { MAX_AUDIT_BYTES, MAX_AUDIT_EVENTS, normalizeRelativePath, evaluateFilesystemAccess, combineFilesystemDecisions, createSecurityAuditStore };
