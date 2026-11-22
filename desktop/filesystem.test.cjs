"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { listDirectory, readProjectFile, writeProjectFile } = require("./filesystem.cjs");

test("project file adapter lists, reads, and writes files within the workspace", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-files-"));
  try {
    const workspace = path.join(temporary, "repo");
    await fs.mkdir(path.join(workspace, "src"), { recursive: true });
    await fs.mkdir(path.join(workspace, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(workspace, "src", "hello.ts"), "export const hello = true;");
    const entries = await listDirectory(workspace, "src");
    assert.deepEqual(entries.map(entry => entry.name), ["hello.ts"]);
    assert.equal((await readProjectFile(workspace, "src/hello.ts")).content, "export const hello = true;");
    await writeProjectFile(workspace, "src/hello.ts", "export const hello = false;");
    assert.equal(await fs.readFile(path.join(workspace, "src", "hello.ts"), "utf8"), "export const hello = false;");
    await assert.rejects(() => listDirectory(workspace, "node_modules"), /excluded/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("project file adapter rejects traversal, absolute paths, and symlinks", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-files-"));
  try {
    const workspace = path.join(temporary, "repo");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(temporary, "outside.txt"), "private");
    await assert.rejects(() => readProjectFile(workspace, "../outside.txt"), /traversal/);
    await assert.rejects(() => readProjectFile(workspace, path.join(temporary, "outside.txt")), /Absolute paths/);
    await fs.symlink(path.join(temporary, "outside.txt"), path.join(workspace, "link.txt"));
    await assert.rejects(() => readProjectFile(workspace, "link.txt"), /Symbolic links/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("project file writes reject symlink targets and leave no temporary files", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-files-"));
  try {
    const workspace = path.join(temporary, "repo");
    await fs.mkdir(workspace);
    const outside = path.join(temporary, "outside.txt");
    await fs.writeFile(outside, "do not overwrite");
    await fs.symlink(outside, path.join(workspace, "link.txt"));
    await assert.rejects(() => writeProjectFile(workspace, "link.txt", "malicious"), /Symbolic links/);
    assert.equal(await fs.readFile(outside, "utf8"), "do not overwrite");
    await writeProjectFile(workspace, "safe.txt", "atomic");
    assert.equal(await fs.readFile(path.join(workspace, "safe.txt"), "utf8"), "atomic");
    assert.deepEqual((await fs.readdir(workspace)).sort(), ["link.txt", "safe.txt"]);
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
});
