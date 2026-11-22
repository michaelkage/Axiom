"use strict";

const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const crypto = require("node:crypto");
const path = require("node:path");

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_DIRECTORY_SCAN = 2000;
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".axiom", "dist", "out", ".next", ".env", ".env.local", ".env.production", "id_rsa", "id_ed25519"]);

function normalizeRelativePath(relativePath = "") {
  if (typeof relativePath !== "string" || relativePath.length > 4096) {
    throw new TypeError("A relative project path is required.");
  }
  const normalized = relativePath.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[a-zA-Z]:/.test(normalized)) {
    throw new Error("Absolute paths are not allowed.");
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some(segment => segment === "." || segment === ".." || segment.includes("\0"))) {
    throw new Error("Path traversal is not allowed.");
  }
  if (segments.some(segment => BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
    throw new Error("This project path is excluded from desktop file access.");
  }
  return segments;
}

async function resolveSafePath(workspaceRoot, relativePath, { allowMissingFinal = false } = {}) {
  const root = await fs.realpath(workspaceRoot);
  const segments = normalizeRelativePath(relativePath);
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    const final = index === segments.length - 1;
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) throw new Error("Symbolic links are not allowed in project file operations.");
      if (!final && !stat.isDirectory()) throw new Error("A parent path is not a directory.");
    } catch (error) {
      if (error.code === "ENOENT" && final && allowMissingFinal) continue;
      throw error;
    }
  }
  const resolved = path.resolve(root, ...segments);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error("The requested path is outside the selected project.");
  }
  return { root, path: resolved, segments };
}

async function listDirectory(workspaceRoot, relativePath = "") {
  const target = await resolveSafePath(workspaceRoot, relativePath);
  const stat = await fs.stat(target.path);
  if (!stat.isDirectory()) throw new Error("The requested project path is not a directory.");
  const entries = [];
  const directory = await fs.opendir(target.path);
  for await (const entry of directory) {
    entries.push(entry);
    if (entries.length >= MAX_DIRECTORY_SCAN) break;
  }
  return entries
    .filter(entry => !BLOCKED_SEGMENTS.has(entry.name.toLowerCase()) && !entry.isSymbolicLink())
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map(entry => ({
      name: entry.name,
      path: [...target.segments, entry.name].join("/"),
      kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other"
    }));
}

async function readProjectFile(workspaceRoot, relativePath) {
  const target = await resolveSafePath(workspaceRoot, relativePath);
  let handle;
  try {
    handle = await fs.open(target.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Only regular files can be read.");
    if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB desktop preview limit.");
    const buffer = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB desktop preview limit.");
    const content = buffer.subarray(0, bytesRead).toString("utf8");
    return { path: target.segments.join("/"), content, size: bytesRead };
  } catch (error) {
    if (error && error.code === "ELOOP") throw new Error("Symbolic links are not allowed in project file operations.");
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

async function writeProjectFile(workspaceRoot, relativePath, content) {
  if (typeof content !== "string") throw new TypeError("File content must be text.");
  const size = Buffer.byteLength(content, "utf8");
  if (size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB desktop edit limit.");
  const target = await resolveSafePath(workspaceRoot, relativePath, { allowMissingFinal: true });
  if (!target.segments.length) throw new Error("A project file path is required.");
  const parent = path.dirname(target.path);
  const parentStat = await fs.lstat(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("The destination parent is not a safe directory.");
  let existing;
  try { existing = await fs.lstat(target.path); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new Error("Only regular files can be edited.");
  const temporary = path.join(parent, ".axiom-write-" + crypto.randomUUID() + ".tmp");
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(content, { encoding: "utf8" });
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, target.path);
    try {
      const directory = await fs.open(parent, fsConstants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch { /* Directory fsync is not supported on every platform/filesystem. */ }
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
  return { path: target.segments.join("/"), size };
}

module.exports = { MAX_FILE_BYTES, MAX_DIRECTORY_ENTRIES, MAX_DIRECTORY_SCAN, listDirectory, readProjectFile, writeProjectFile, normalizeRelativePath };
