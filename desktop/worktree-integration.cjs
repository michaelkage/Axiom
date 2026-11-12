"use strict";

const fsNative = require("node:fs");
const fs = fsNative.promises;
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

async function readRegularFileNoFollow(filePath) {
  const before = await fs.lstat(filePath);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error("Only regular, non-symlink files can be read for worker integration.");
  const flags = fsNative.constants.O_RDONLY | (fsNative.constants.O_NOFOLLOW || 0);
  const handle = await fs.open(filePath, flags);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error("Worker file changed during safe-open verification.");
    }
    const content = await handle.readFile();
    return { content, mode: stat.mode & 0o777, size: content.length, dev: stat.dev, ino: stat.ino };
  } finally {
    await handle.close();
  }
}

async function applyStagedWorkspaceFiles(staged, options = {}) {
  const io = options.fs || fs;
  const appliedPaths = [];
  try {
    try {
      for (const item of staged) {
        if (item.content === null) continue;
        item.temporary = item.destination + ".axiom-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".tmp";
        await io.writeFile(item.temporary, item.content, { flag: "wx", mode: item.sourceMode });
        await io.chmod(item.temporary, item.sourceMode);
      }
    } catch (prepareError) {
      for (const item of staged) if (item.temporary) { try { await io.unlink(item.temporary); } catch {} }
      throw new Error("Integration preflight could not stage every file; no destination files were changed. " + prepareError.message);
    }

    try {
      for (const item of staged) {
        if (options.beforeApply) await options.beforeApply(item);
        if (item.content === null) {
          try { await io.unlink(item.destination); }
          catch (error) { if (error.code !== "ENOENT") throw error; }
        } else {
          await io.rename(item.temporary, item.destination);
          item.temporary = null;
        }
        appliedPaths.push(item.relative);
      }
      return appliedPaths;
    } catch (applyError) {
      const rollbackErrors = [];
      for (const item of [...staged].reverse()) {
        if (!appliedPaths.includes(item.relative)) continue;
        try {
          if (item.existed) {
            const rollbackPath = item.destination + ".axiom-rollback-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(36).slice(2) + ".tmp";
            try {
              await io.writeFile(rollbackPath, item.backup, { flag: "wx", mode: item.backupMode });
              await io.chmod(rollbackPath, item.backupMode);
              await io.rename(rollbackPath, item.destination);
            } finally {
              try { await io.unlink(rollbackPath); } catch {}
            }
          } else {
            try { await io.unlink(item.destination); }
            catch (error) { if (error.code !== "ENOENT") throw error; }
          }
        } catch (rollbackError) {
          rollbackErrors.push(item.relative + ": " + rollbackError.message);
        }
      }
      const pathsStillApplied = new Set(rollbackErrors.map(entry => entry.slice(0, entry.indexOf(": "))));
      const residue = appliedPaths.filter(relative => pathsStillApplied.has(relative));
      const failure = new Error("Integration transaction failed: " + applyError.message + (rollbackErrors.length
        ? ". Rollback failed for " + rollbackErrors.join("; ")
        : ". Applied files were rolled back."));
      failure.appliedPaths = residue;
      throw failure;
    }
  } finally {
    for (const item of staged) if (item.temporary) { try { await io.unlink(item.temporary); } catch {} }
  }
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

module.exports = { normalizeWorkspaceRelativePath, resolveSafeWorkspaceFile, readRegularFileNoFollow, applyStagedWorkspaceFiles, withWorkspaceIntegrationLock };
