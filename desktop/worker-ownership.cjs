"use strict";

const path = require("node:path");
const { normalizeWorkspaceRelativePath } = require("./worktree-integration.cjs");

function normalizeTaskId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new TypeError("Invalid worker task ID.");
  return value;
}
function createWorkerOwnershipRegistry() {
  const owners = new Map();
  function claim(taskId, paths) {
    const id = normalizeTaskId(taskId);
    if (!Array.isArray(paths) || paths.length > 2000) throw new TypeError("Worker file ownership must be a bounded path list.");
    const normalized = [...new Set(paths.map(normalizeWorkspaceRelativePath))].sort();
    for (const candidate of normalized) {
      for (const [owner, owned] of owners) {
        if (owner === id) continue;
        if (owned.some(existing => candidate === existing || candidate.startsWith(existing + "/") || existing.startsWith(candidate + "/"))) {
          throw new Error("Worker file ownership conflict: " + candidate + " is already owned by task " + owner + ".");
        }
      }
    }
    owners.set(id, normalized);
    return { taskId: id, paths: normalized };
  }
  function release(taskId) { return owners.delete(normalizeTaskId(taskId)); }
  function validateChanges(taskId, changedPaths) {
    const id = normalizeTaskId(taskId);
    const owned = owners.get(id);
    if (!owned) throw new Error("Worker task has no registered file ownership.");
    if (!Array.isArray(changedPaths) || changedPaths.length > 5000) throw new TypeError("Changed file list is invalid or exceeds the limit.");
    const violations = [];
    const normalized = changedPaths.map(normalizeWorkspaceRelativePath);
    for (const changed of normalized) {
      if (!owned.some(root => changed === root || changed.startsWith(root + "/"))) violations.push(changed);
    }
    return { allowed: violations.length === 0, taskId: id, changedPaths: normalized, violations };
  }
  function snapshot() { return [...owners].map(([taskId, paths]) => ({ taskId, paths: [...paths] })); }
  return Object.freeze({ claim, release, validateChanges, snapshot });
}
module.exports = { createWorkerOwnershipRegistry, normalizeTaskId };
