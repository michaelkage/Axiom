"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { safeRemoteUrl, createRemoteWorkspace, commitAndPushWorkspace, cleanupRemoteWorkspace, git } = require("./remote-workspace-runner.cjs");

test("remote workspace runner rejects embedded credentials", () => {
  assert.throws(() => safeRemoteUrl("https://user:token@example.com/org/repo.git"), /embedded credentials/);
  assert.throws(() => safeRemoteUrl("https://example.com/org/repo.git?token=secret"), /embedded credentials/);
});
test("remote workspace runner accepts credential-free HTTPS and SSH remotes", () => {
  assert.equal(safeRemoteUrl("https://github.com/org/repo.git"), "https://github.com/org/repo.git");
  assert.equal(safeRemoteUrl("ssh://git@github.com/org/repo.git"), "ssh://git@github.com/org/repo.git");
  assert.equal(safeRemoteUrl("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
});

test("remote workspace runner rejects unsafe protocols and malformed SSH remotes", () => {
  assert.throws(() => safeRemoteUrl("http://github.com/org/repo.git"), /HTTPS or SSH/);
  assert.throws(() => safeRemoteUrl("file:///tmp/repo.git"), /HTTPS or SSH/);
  assert.throws(() => safeRemoteUrl("git@github.com"), /SSH repository URL/);
  assert.throws(() => safeRemoteUrl("git@github.com:org/repo.git?token=secret"), /SSH repository URL/);
  assert.throws(() => safeRemoteUrl("ssh://user:token@github.com/org/repo.git"), /embedded credentials/);
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


test("remote workspace verifies, commits, pushes, confirms the remote SHA, then cleans up", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-push-verify-"));
  const remote = path.join(root, "remote.git");
  const temporaryRoot = path.join(root, "jobs");
  const workspacePath = path.join(temporaryRoot, "job-1");
  try {
    await fs.mkdir(temporaryRoot, { recursive: true });
    await git(root, ["init", "--bare", remote]);
    await fs.mkdir(workspacePath, { recursive: true });
    await git(workspacePath, ["init", "--initial-branch", "main"]);
    await git(workspacePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
    await git(workspacePath, ["remote", "add", "origin", remote]);
    await git(workspacePath, ["push", "-u", "origin", "main"]);
    await fs.writeFile(path.join(workspacePath, "feature.txt"), "verified change\n");
    const job = {
      mode: "temporary-full", repositoryUrl: remote, branch: "main",
      workspacePath, temporaryRoot, workspaceOwnership: "axiom-job",
      status: "ready", verificationPassed: false, pushSucceeded: false,
      remoteCommitConfirmed: false
    };
    let verifyCalls = 0;
    const result = await commitAndPushWorkspace(job, {
      message: "add verified feature",
      verify: async directory => {
        verifyCalls += 1;
        assert.equal(directory, workspacePath);
        assert.equal(await fs.readFile(path.join(directory, "feature.txt"), "utf8"), "verified change\n");
        return true;
      }
    });
    assert.equal(verifyCalls, 1);
    assert.equal(result.status, "pushed");
    assert.equal(job.verificationPassed, true);
    assert.equal(job.pushSucceeded, true);
    assert.equal(job.remoteCommitConfirmed, true);
    assert.match(job.commitSha, /^[0-9a-f]{40}$/);
    const remoteSha = (await git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout;
    assert.equal(remoteSha, job.commitSha);
    const cleaned = await cleanupRemoteWorkspace(job);
    assert.equal(cleaned.cleaned, true);
    await assert.rejects(() => fs.stat(workspacePath), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("remote workspace refuses commit and push when verification fails", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-push-block-"));
  const remote = path.join(root, "remote.git");
  const workspacePath = path.join(root, "workspace");
  try {
    await git(root, ["init", "--bare", remote]);
    await fs.mkdir(workspacePath, { recursive: true });
    await git(workspacePath, ["init", "--initial-branch", "main"]);
    await git(workspacePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
    await git(workspacePath, ["remote", "add", "origin", remote]);
    await git(workspacePath, ["push", "-u", "origin", "main"]);
    await fs.writeFile(path.join(workspacePath, "unsafe.txt"), "not verified");
    const job = {
      mode: "temporary-full", repositoryUrl: remote, branch: "main",
      workspacePath, temporaryRoot: root, workspaceOwnership: "axiom-job",
      status: "ready", verificationPassed: false, pushSucceeded: false,
      remoteCommitConfirmed: false
    };
    await assert.rejects(() => commitAndPushWorkspace(job, {
      verify: async () => false
    }), /verification did not pass/);
    assert.equal(job.status, "failed");
    assert.equal(job.pushSucceeded, false);
    assert.equal((await git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout,
      (await git(workspacePath, ["rev-parse", "HEAD"])).stdout);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
