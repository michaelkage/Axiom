"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");

const MEMORY_DIRECTORY = ".axiom";
const MEMORY_FILE = "memory.json";
const MAX_MEMORY_BYTES = 1024 * 1024;
const CATEGORIES = new Set(["architecture", "convention", "decision", "preference", "fix", "failure"]);

function validateMemories(value) {
  if (!Array.isArray(value) || value.length > 2000) throw new TypeError("Project memory must be an array with at most 2,000 entries.");
  const ids = new Set();
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.id)
      || ids.has(item.id) || !CATEGORIES.has(item.category)
      || typeof item.content !== "string" || !item.content.trim() || item.content.length > 8000
      || !Array.isArray(item.tags) || item.tags.length > 32
      || item.tags.some(tag => typeof tag !== "string" || tag.length > 80 || /[\x00-\x1f\x7f]/.test(tag))
      || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
      || typeof item.updatedAt !== "string" || !Number.isFinite(Date.parse(item.updatedAt))) {
      throw new TypeError("Invalid project memory entry at index " + index + ".");
    }
    ids.add(item.id);
    return {
      id: item.id, category: item.category, content: item.content,
      tags: [...new Set(item.tags)], createdAt: item.createdAt, updatedAt: item.updatedAt
    };
  });
}

function createProjectMemoryStore(workspaceRoot, fsImpl = fs) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new TypeError("A selected absolute project directory is required.");
  }
  const root = path.resolve(workspaceRoot);
  const directory = path.join(root, MEMORY_DIRECTORY);
  const file = path.join(directory, MEMORY_FILE);

  async function ensureDirectory(create) {
    const rootStat = await fsImpl.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Project root must be a real directory.");
    try {
      const stat = await fsImpl.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The .axiom memory directory must be a real directory, not a symlink.");
    } catch (error) {
      if (error.code !== "ENOENT" || !create) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
      await fsImpl.mkdir(directory, { mode: 0o700 });
      const created = await fsImpl.lstat(directory);
      if (!created.isDirectory() || created.isSymbolicLink()) throw new Error("Could not safely create the .axiom memory directory.");
    }
    return true;
  }

  return {
    async load() {
      if (!await ensureDirectory(false)) return [];
      let stat;
      try { stat = await fsImpl.lstat(file); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The project memory file must be a regular file.");
      if (stat.size > MAX_MEMORY_BYTES) throw new Error("Project memory exceeds the 1 MiB limit.");
      const parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
      if (!parsed || parsed.version !== 1) throw new Error("Unsupported .axiom/memory.json format version.");
      return validateMemories(parsed.memories);
    },
    async save(memories) {
      const validated = validateMemories(memories);
      const payload = JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), memories: validated }, null, 2) + "\n";
      if (Buffer.byteLength(payload, "utf8") > MAX_MEMORY_BYTES) throw new Error("Project memory exceeds the 1 MiB limit.");
      await ensureDirectory(true);
      try {
        const stat = await fsImpl.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("The project memory file must be a regular file.");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const temporary = path.join(directory, ".memory-" + process.pid + "-" + require("node:crypto").randomUUID() + ".tmp");
      try {
        const handle = await fsImpl.open(temporary, "wx", 0o600);
        try { await handle.writeFile(payload, "utf8"); await handle.sync(); }
        finally { await handle.close(); }
        await fsImpl.rename(temporary, file);
        try { await fsImpl.chmod(file, 0o600); } catch {}
      } finally {
        await fsImpl.rm(temporary, { force: true }).catch(() => {});
      }
      return validated;
    }
  };
}

module.exports = { createProjectMemoryStore, validateMemories, MAX_MEMORY_BYTES };
