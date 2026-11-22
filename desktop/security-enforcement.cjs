"use strict";

const path = require("node:path");

const BLOCKED = new Set([".git", "node_modules", ".axiom", "dist", "out", ".next", ".env", ".env.local", ".env.production", "id_rsa", "id_ed25519"]);

function normalizeRelativePath(value) {
  if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) throw new TypeError("A workspace-relative path is required.");
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized) || normalized.startsWith("//")) throw new Error("Absolute paths are denied by project security policy.");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === ".." || segment.includes("\0"))) throw new Error("Path traversal is denied by project security policy.");
  if (segments.some(segment => BLOCKED.has(segment.toLowerCase()) || segment.toLowerCase().startsWith(".env."))) throw new Error("This path is denied by project security policy.");
  return segments.join("/");
}

function evaluateFilesystemAccess({ workspaceRoot, relativePath, operation }) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) return { decision: "deny", reason: "No trusted workspace is selected." };
  if (!["read", "write"].includes(operation)) return { decision: "deny", reason: "Unknown filesystem operation." };
  let relative;
  try { relative = normalizeRelativePath(relativePath); }
  catch (error) { return { decision: "deny", reason: error.message }; }
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, ...relative.split("/").filter(Boolean));
  if (target !== root && !target.startsWith(root + path.sep)) return { decision: "deny", reason: "Filesystem target escapes the selected workspace." };
  if (operation === "write") return { decision: "approval-required", reason: "Project file modifications require explicit native confirmation." };
  return { decision: "allow", reason: "Read is confined to a safe workspace-relative path." };
}

function createSecurityAuditStore({ userDataPath, fsImpl = require("node:fs") }) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) throw new TypeError("A user-data directory is required.");
  const file = path.join(userDataPath, "security-audit.jsonl");
  function record(input) {
    const event = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      action: String(input.action || "unknown").slice(0, 80),
      decision: ["allow", "deny", "approval-required"].includes(input.decision) ? input.decision : "deny",
      reason: String(input.reason || "").slice(0, 500),
      projectId: typeof input.projectId === "string" ? input.projectId.slice(0, 128) : null,
      resource: typeof input.resource === "string" ? input.resource.slice(0, 512) : null,
      actor: "desktop-main"
    };
    fsImpl.mkdirSync(userDataPath, { recursive: true, mode: 0o700 });
    fsImpl.appendFileSync(file, JSON.stringify(event) + "\n", { encoding: "utf8", mode: 0o600 });
    return event;
  }
  function list(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Audit limit must be between 1 and 1000.");
    let raw;
    try { raw = fsImpl.readFileSync(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    return raw.split("\n").filter(Boolean).slice(-limit).flatMap(line => {
      try {
        const item = JSON.parse(line);
        return item.schemaVersion === 1 && typeof item.timestamp === "string" ? [item] : [];
      } catch { return []; }
    });
  }
  return Object.freeze({ record, list });
}

module.exports = { normalizeRelativePath, evaluateFilesystemAccess, createSecurityAuditStore };
