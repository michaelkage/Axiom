"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createDetachedWorktree } = require("./worker-worktree.cjs");

const execFileAsync = promisify(execFile);

async function git(root, args) {
  return execFileAsync("git", ["-C", root, ...args], { windowsHide: true, timeout: 15000 });
}

async function createRepository(root) {
  await fs.mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", root], { windowsHide: true, timeout: 15000 });
  await git(root, ["config", "user.name", "Axiom Tests"]);
  await git(root, ["config", "user.email", "axiom-tests@example.invalid"]);
  await fs.writeFile(path.join(root, "README.md"), "worker worktree fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["commit", "-m", "Initial fixture"]);
}

test("creates a detached worker worktree from the selected repository HEAD", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-worktree-"));
  const root = path.join(temp, "workspace");
  const userDataPath = path.join(temp, "user-data");
  try {
    await createRepository(root);
    const expectedHead = (await git(root, ["rev-parse", "HEAD"])).stdout.trim();
    const worktreePath = await createDetachedWorktree({
      workspaceRoot: root,
      userDataPath,
      taskId: "worker-one",
      now: () => 1234,
      createId: () => "unique-one",
    });

    const actualRoot = (await git(worktreePath, ["rev-parse", "--show-toplevel"])).stdout.trim();
    const actualHead = (await git(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
    const branch = (await git(worktreePath, ["symbolic-ref", "--short", "-q", "HEAD"]).catch(() => ({ stdout: "" }))).stdout.trim();

    assert.equal(actualRoot, worktreePath);
    assert.equal(actualHead, expectedHead);
    assert.equal(branch, "", "Worker worktrees must remain detached.");
    assert.equal((await fs.stat(path.join(worktreePath, ".git"))).isFile(), true);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("allocates distinct worktree paths for concurrent attempts with the same task ID", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-worktree-parallel-"));
  const root = path.join(temp, "workspace");
  const userDataPath = path.join(temp, "user-data");
  let sequence = 0;
  try {
    await createRepository(root);
    const create = () => createDetachedWorktree({
      workspaceRoot: root,
      userDataPath,
      taskId: "same-task",
      now: () => 1234,
      createId: () => "attempt-" + (++sequence),
    });
    const paths = await Promise.all([create(), create(), create()]);
    assert.equal(new Set(paths).size, 3);
    for (const worktreePath of paths) {
      assert.equal((await git(worktreePath, ["rev-parse", "--show-toplevel"])).stdout.trim(), worktreePath);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});

test("rejects a workspace that is not inside a Git repository", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-worktree-invalid-"));
  const workspaceRoot = path.join(temp, "not-a-repository");
  try {
    await fs.mkdir(workspaceRoot);
    await assert.rejects(createDetachedWorktree({
      workspaceRoot,
      userDataPath: path.join(temp, "user-data"),
      taskId: "invalid",
    }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
