"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

function normalizeWorkspaceRelativePath(value) {
  if (typeof value !== "string" || !value || value.length > 512 || value !== value.trim()
    || /[\\x00-\\x1f\\x7f]/.test(value)) {
    throw new Error("Invalid workspace-relative file path.");
  }
  const portable = value.replace(/\\\\/g, "/");
  const segments = portable.split("/");
  if (portable.startsWith("/") || /^[a-z]:/i.test(portable)
    || segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    throw new Error("Workspace file paths must be normalized, relative paths without traversal segments.");
  }
  return segments.join("/");
}

async function resolveSafeWorkspaceFile(root, relativePath) {
  const normalized = normalizeWorkspaceRelativePath(relativePath);
  const realRoot = await fs.realpath(root);
  let current = realRoot;
  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index++) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === "ENOENT") return path.join(current, ...segments.slice(index + 1));
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Workspace paths containing symbolic links are not allowed: " + normalized);
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !stat.isDirectory()) throw new Error("A workspace path component is not a directory: " + normalized);
    if (isLeaf && !stat.isFile()) throw new Error("Only regular files can be integrated: " + normalized);
  }
  return current;
}

const workspaceLocks = new Map();
async function withWorkspaceIntegrationLock(root, operation) {
  const key = path.resolve(root);
  const previous = workspaceLocks.get(key);
  let release;
  const current = new Promise(resolve => { release = resolve; });
  workspaceLocks.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (workspaceLocks.get(key) === current) workspaceLocks.delete(key);
  }
}

module.exports = { normalizeWorkspaceRelativePath, resolveSafeWorkspaceFile, withWorkspaceIntegrationLock };
