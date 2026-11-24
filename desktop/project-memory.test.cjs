"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createProjectMemoryStore } = require("./project-memory.cjs");

const entry = { id: "architecture-1", category: "architecture", content: "Keep IPC handlers in the main process.", tags: ["ipc"], createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z" };

test("project memory is stored as a versioned, portable repository file", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-project-memory-"));
  const root = path.join(temp, "repo");
  await fs.mkdir(root);
  try {
    const store = createProjectMemoryStore(root);
    assert.deepEqual(await store.load(), []);
    await store.save([entry]);
    const raw = JSON.parse(await fs.readFile(path.join(root, ".axiom", "memory.json"), "utf8"));
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.memories, [entry]);
    assert.deepEqual(await store.load(), [entry]);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("project memory rejects malformed entries and unsupported formats", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-project-memory-"));
  try {
    const store = createProjectMemoryStore(temp);
    await assert.rejects(() => store.save([{ ...entry, id: "../escape" }]), /Invalid project memory/);
    await fs.mkdir(path.join(temp, ".axiom"));
    await fs.writeFile(path.join(temp, ".axiom", "memory.json"), JSON.stringify({ version: 2, memories: [] }));
    await assert.rejects(() => store.load(), /Unsupported/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});

test("project memory rejects symlinked metadata directories and files", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-project-memory-"));
  const root = path.join(temp, "repo");
  const outside = path.join(temp, "outside");
  await fs.mkdir(root); await fs.mkdir(outside);
  try {
    await fs.symlink(outside, path.join(root, ".axiom"), "dir");
    await assert.rejects(() => createProjectMemoryStore(root).save([entry]), /symlink/);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
});
