"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeWorkspaceRelativePath, resolveSafeWorkspaceFile, readRegularFileNoFollow, applyStagedWorkspaceFiles, withWorkspaceIntegrationLock } = require("./worktree-integration.cjs");

test("normalizes safe workspace-relative paths and rejects traversal or ambiguous paths", () => {
  assert.equal(normalizeWorkspaceRelativePath("src\\feature.ts"), "src/feature.ts");
  for (const value of ["", "../outside", "src/../outside", "/etc/passwd", "C:/Windows/file", "src//file", "src/./file", " src/file", "src/file ", "src\\..\\outside", "src/file:name", "src/\0file"]) {
    assert.throws(() => normalizeWorkspaceRelativePath(value), /Invalid workspace-relative|normalized, relative/);
  }
});

test("rejects symlinks in parent and leaf components while allowing missing files", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worktree-path-"));
  try {
    const root = path.join(temporary, "repo");
    const outside = path.join(temporary, "outside");
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret");
    await fs.writeFile(path.join(root, "src", "safe.ts"), "safe");
    assert.equal(await resolveSafeWorkspaceFile(root, "src/safe.ts"), path.join(root, "src", "safe.ts"));
    assert.equal(await resolveSafeWorkspaceFile(root, "src/new.ts"), path.join(root, "src", "new.ts"));
    await fs.symlink(outside, path.join(root, "linked"), "junction");
    await assert.rejects(() => resolveSafeWorkspaceFile(root, "linked/secret.txt"), /symbolic links/);
    await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "secret-link.ts"));
    await assert.rejects(() => resolveSafeWorkspaceFile(root, "secret-link.ts"), /symbolic links/);
    await assert.rejects(() => resolveSafeWorkspaceFile(root, "src/safe.ts/child"), /not a directory/);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("opens regular files without following a replaced symlink leaf", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worktree-nofollow-"));
  try {
    const rootFile = path.join(temporary, "safe.txt");
    const outsideFile = path.join(temporary, "outside.txt");
    const link = path.join(temporary, "link.txt");
    await fs.writeFile(rootFile, "safe");
    await fs.writeFile(outsideFile, "outside");
    const read = await readRegularFileNoFollow(rootFile);
    assert.equal(read.content.toString("utf8"), "safe");
    assert.equal(read.size, 4);
    await fs.symlink(outsideFile, link);
    await assert.rejects(() => readRegularFileNoFollow(link));
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("serializes integration operations per workspace without blocking other workspaces", async () => {
  const order = [];
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const first = withWorkspaceIntegrationLock("/tmp/axiom-lock-a", async () => { order.push("first-start"); await gate; order.push("first-end"); });
  const second = withWorkspaceIntegrationLock("/tmp/axiom-lock-a", async () => { order.push("second"); });
  const independent = withWorkspaceIntegrationLock("/tmp/axiom-lock-b", async () => { order.push("independent"); });
  await independent;
  await Promise.resolve();
  assert.deepEqual(order, ["first-start", "independent"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["first-start", "independent", "first-end", "second"]);
});

test("applies replacements, additions and deletions while preserving file modes", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worktree-transaction-"));
  try {
    const root = path.join(temporary, "repo");
    await fs.mkdir(root);
    const changed = path.join(root, "run.sh");
    const removed = path.join(root, "remove.txt");
    const added = path.join(root, "new.txt");
    await fs.writeFile(changed, "old", { mode: 0o755 });
    await fs.chmod(changed, 0o755);
    await fs.writeFile(removed, "remove me");
    const changedStat = await fs.stat(changed);
    const result = await applyStagedWorkspaceFiles([
      { relative: "run.sh", destination: changed, content: Buffer.from("new"), sourceMode: 0o755, existed: true, backup: Buffer.from("old"), backupMode: changedStat.mode & 0o777 },
      { relative: "remove.txt", destination: removed, content: null, existed: true, backup: Buffer.from("remove me"), backupMode: 0o644 },
      { relative: "new.txt", destination: added, content: Buffer.from("added"), sourceMode: 0o644, existed: false, backup: null, backupMode: null }
    ]);
    assert.deepEqual(result, ["run.sh", "remove.txt", "new.txt"]);
    assert.equal(await fs.readFile(changed, "utf8"), "new");
    assert.equal((await fs.stat(changed)).mode & 0o777, 0o755);
    await assert.rejects(() => fs.stat(removed), { code: "ENOENT" });
    assert.equal(await fs.readFile(added, "utf8"), "added");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("rolls back already-applied files when a later atomic replacement fails", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worktree-rollback-"));
  try {
    const first = path.join(temporary, "first.txt");
    const second = path.join(temporary, "second.txt");
    await fs.writeFile(first, "original-first");
    await fs.writeFile(second, "original-second");
    let renameCount = 0;
    const io = {
      writeFile: fs.writeFile.bind(fs),
      chmod: fs.chmod.bind(fs),
      unlink: fs.unlink.bind(fs),
      rename: async (...args) => {
        renameCount++;
        if (renameCount === 2) throw new Error("injected second-file failure");
        return fs.rename(...args);
      }
    };
    await assert.rejects(() => applyStagedWorkspaceFiles([
      { relative: "first.txt", destination: first, content: Buffer.from("changed-first"), sourceMode: 0o644, existed: true, backup: Buffer.from("original-first"), backupMode: 0o644 },
      { relative: "second.txt", destination: second, content: Buffer.from("changed-second"), sourceMode: 0o644, existed: true, backup: Buffer.from("original-second"), backupMode: 0o644 }
    ], { fs: io }), error => {
      assert.match(error.message, /Applied files were rolled back/);
      assert.deepEqual(error.appliedPaths, []);
      return true;
    });
    assert.equal(await fs.readFile(first, "utf8"), "original-first");
    assert.equal(await fs.readFile(second, "utf8"), "original-second");
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});
