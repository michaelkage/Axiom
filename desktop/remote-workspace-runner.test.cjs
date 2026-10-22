"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { safeRemoteUrl, createRemoteWorkspace, git } = require("./remote-workspace-runner.cjs");

test("remote workspace runner rejects embedded credentials", () => {
  assert.throws(() => safeRemoteUrl("https://user:token@example.com/org/repo.git"), /embedded credentials/);
  assert.throws(() => safeRemoteUrl("https://example.com/org/repo.git?token=secret"), /embedded credentials/);
});
test("remote workspace runner accepts credential-free HTTPS and SSH remotes", () => {
  assert.equal(safeRemoteUrl("https://github.com/org/repo.git"), "https://github.com/org/repo.git");
  assert.equal(safeRemoteUrl("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
});

async function makeCheckout(directory, { remote = "https://github.com/org/repo.git", branch = "feature/axiom" } = {}) {
  await fs.mkdir(directory, { recursive: true });
  await git(directory, ["init", "--initial-branch", branch]);
  await git(directory, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
  await git(directory, ["remote", "add", "origin", remote]);
}

test("persistent workspace reuses a clean checkout with matching origin and branch", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-persistent-reuse-"));
  const checkout = path.join(root, "checkout");
  try {
    await makeCheckout(checkout);
    const job = await createRemoteWorkspace({
      mode: "persistent", repositoryUrl: "https://github.com/org/repo.git",
      branch: "feature/axiom", persistentPath: checkout
    }, { temporaryRoot: path.join(root, "temporary") });
    assert.equal(job.workspacePath, checkout);
    assert.equal(job.reusedExistingCheckout, true);
    assert.equal(job.workspaceOwnership, "user");
    assert.equal(job.status, "ready");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persistent workspace refuses to reuse a checkout with uncommitted changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-persistent-dirty-"));
  const checkout = path.join(root, "checkout");
  try {
    await makeCheckout(checkout);
    await fs.writeFile(path.join(checkout, "uncommitted.txt"), "keep me");
    await assert.rejects(() => createRemoteWorkspace({
      mode: "persistent", repositoryUrl: "https://github.com/org/repo.git",
      branch: "feature/axiom", persistentPath: checkout
    }, { temporaryRoot: path.join(root, "temporary") }), /uncommitted changes/);
    assert.equal(await fs.readFile(path.join(checkout, "uncommitted.txt"), "utf8"), "keep me");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("persistent workspace refuses origin and branch mismatches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-persistent-mismatch-"));
  const checkout = path.join(root, "checkout");
  try {
    await makeCheckout(checkout, { remote: "https://github.com/other/repo.git" });
    await assert.rejects(() => createRemoteWorkspace({
      mode: "persistent", repositoryUrl: "https://github.com/org/repo.git",
      branch: "feature/axiom", persistentPath: checkout
    }, { temporaryRoot: path.join(root, "temporary") }), /origin does not match/);
    await git(checkout, ["remote", "set-url", "origin", "https://github.com/org/repo.git"]);
    await assert.rejects(() => createRemoteWorkspace({
      mode: "persistent", repositoryUrl: "https://github.com/org/repo.git",
      branch: "other-branch", persistentPath: checkout
    }, { temporaryRoot: path.join(root, "temporary") }), /not requested branch/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
