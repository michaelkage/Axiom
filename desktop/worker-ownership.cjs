"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { normalizeWorkspaceRelativePath } = require("./worktree-integration.cjs");

function normalizeTaskId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new TypeError("Invalid worker task ID.");
  return value;
}

function createWorkerOwnershipRegistry(options = {}) {
  const owners = new Map();
  const filePath = options.filePath ? path.resolve(options.filePath) : null;
  const workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : null;
  const maxClaims = Math.min(Math.max(Number(options.maxClaims) || 2000, 1), 10000);
  let revision = 0;

  function persist() {
    if (!filePath) return;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = JSON.stringify({
      schemaVersion: 1,
      workspaceRoot,
      revision,
      claims: [...owners].map(([taskId, paths]) => ({ taskId, paths }))
    });
    const temporary = filePath + "." + process.pid + "." + require("node:crypto").randomUUID() + ".tmp";
    let fd;
    try {
      fd = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(fd, payload, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, filePath);
    } catch (error) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      try { fs.unlinkSync(temporary); } catch {}
      throw error;
    }
  }

  function restore() {
    if (!filePath) return;
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(filePath, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return;
      throw new Error("Worker ownership state is corrupt; refusing to discard ownership claims.");
    }
    if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.claims) ||
        (workspaceRoot && parsed.workspaceRoot !== workspaceRoot) || parsed.claims.length > maxClaims) {
      throw new Error("Worker ownership state does not match this workspace or schema.");
    }
    const restored = new Map();
    for (const claim of parsed.claims) {
      const id = normalizeTaskId(claim?.taskId);
      if (restored.has(id) || !Array.isArray(claim.paths) || claim.paths.length > 2000) throw new Error("Worker ownership state contains an invalid claim.");
      const normalized = [...new Set(claim.paths.map(normalizeWorkspaceRelativePath))].sort();
      restored.set(id, normalized);
    }
    // Reject overlapping persisted claims rather than silently selecting an owner.
    const entries = [...restored];
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      for (const a of entries[i][1]) for (const b of entries[j][1]) {
        if (a === b || a.startsWith(b + "/") || b.startsWith(a + "/")) throw new Error("Worker ownership state contains conflicting claims.");
      }
    }
    for (const [id, paths] of restored) owners.set(id, paths);
    revision = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
  }

  function claim(taskId, paths) {
    const id = normalizeTaskId(taskId);
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 2000) throw new TypeError("Worker file ownership must be a non-empty bounded path list.");
    const normalized = [...new Set(paths.map(normalizeWorkspaceRelativePath))].sort();
    for (const candidate of normalized) {
      for (const [owner, owned] of owners) {
        if (owner === id) continue;
        if (owned.some(existing => candidate === existing || candidate.startsWith(existing + "/") || existing.startsWith(candidate + "/"))) {
          throw new Error("Worker file ownership conflict: " + candidate + " is already owned by task " + owner + ".");
        }
      }
    }
    if (!owners.has(id) && owners.size >= maxClaims) throw new Error("Worker ownership claim limit reached.");
    const previous = owners.get(id);
    owners.set(id, normalized);
    revision++;
    try { persist(); } catch (error) {
      if (previous) owners.set(id, previous); else owners.delete(id);
      revision--;
      throw error;
    }
    return { taskId: id, paths: normalized, revision };
  }

  function release(taskId) {
    const id = normalizeTaskId(taskId);
    const previous = owners.get(id);
    if (!previous) return false;
    owners.delete(id);
    revision++;
    try { persist(); } catch (error) {
      owners.set(id, previous);
      revision--;
      throw error;
    }
    return true;
  }

  function validateChanges(taskId, changedPaths) {
    const id = normalizeTaskId(taskId);
    const owned = owners.get(id);
    if (!owned) throw new Error("Worker task has no registered file ownership.");
    if (!Array.isArray(changedPaths) || changedPaths.length > 5000) throw new TypeError("Changed file list is invalid or exceeds the limit.");
    const normalized = changedPaths.map(normalizeWorkspaceRelativePath);
    const violations = normalized.filter(changed => !owned.some(root => changed === root || changed.startsWith(root + "/")));
    return { allowed: violations.length === 0, taskId: id, changedPaths: normalized, violations };
  }

  function reconcile(activeTaskIds) {
    if (!Array.isArray(activeTaskIds)) throw new TypeError("Active task IDs must be an array.");
    const active = new Set(activeTaskIds.map(normalizeTaskId));
    const removed = [];
    for (const id of owners.keys()) if (!active.has(id)) { owners.delete(id); removed.push(id); }
    if (removed.length) { revision++; persist(); }
    return { removed, revision };
  }

  function snapshot() {
    return { revision, workspaceRoot, claims: [...owners].map(([taskId, paths]) => ({ taskId, paths: [...paths] })) };
  }

  restore();
  return Object.freeze({ claim, release, validateChanges, snapshot, reconcile });
}
module.exports = { createWorkerOwnershipRegistry, normalizeTaskId };
