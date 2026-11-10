"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIRECTORY_ENTRIES = 500;
const BLOCKED_SEGMENTS = new Set([".git", "node_modules", ".axiom", "dist", "out", ".next"]);

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
  const entries = await fs.readdir(target.path, { withFileTypes: true });
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
  const stat = await fs.stat(target.path);
  if (!stat.isFile()) throw new Error("Only regular files can be read.");
  if (stat.size > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB desktop preview limit.");
  return { path: target.segments.join("/"), content: await fs.readFile(target.path, "utf8"), size: stat.size };
}

async function writeProjectFile(workspaceRoot, relativePath, content) {
  if (typeof content !== "string") throw new TypeError("File content must be text.");
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw new Error("File exceeds the 1 MiB desktop edit limit.");
  const target = await resolveSafePath(workspaceRoot, relativePath, { allowMissingFinal: true });
  const parent = path.dirname(target.path);
  const parentStat = await fs.stat(parent);
  if (!parentStat.isDirectory()) throw new Error("The destination parent is not a directory.");
  let existing;
  try {
    existing = await fs.lstat(target.path);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error("Only regular files can be edited.");
  }
  await fs.writeFile(target.path, content, { encoding: "utf8", flag: "w" });
  return { path: target.segments.join("/"), size: Buffer.byteLength(content, "utf8") };
}

module.exports = { MAX_FILE_BYTES, MAX_DIRECTORY_ENTRIES, listDirectory, readProjectFile, writeProjectFile, normalizeRelativePath };
