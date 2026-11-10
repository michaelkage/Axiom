"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { safeRemoteUrl, createRemoteWorkspace, commitAndPushWorkspace, reconcileRemoteWorkspace, pushReconciledWorkspace, cleanupRemoteWorkspace, git } = require("./remote-workspace-runner.cjs");

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
  assert.throws(() => safeRemoteUrl("https://github.com/org/repo.git\n--upload-pack=evil"), /valid HTTPS or SSH/);
  assert.throws(() => safeRemoteUrl("https://github.com/org/repo.git\\n"), /valid HTTPS or SSH/);
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


async function makeRecoveryFixture(prefix) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const remote = path.join(root, "remote.git");
  const workspacePath = path.join(root, "workspace");
  await git(root, ["init", "--bare", remote]);
  await fs.mkdir(workspacePath, { recursive: true });
  await git(workspacePath, ["init", "--initial-branch", "main"]);
  await git(workspacePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "initial"]);
  await git(workspacePath, ["remote", "add", "origin", remote]);
  await git(workspacePath, ["push", "-u", "origin", "main"]);
  await git(root, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  const job = { id: "recovery-test", mode: "temporary-full", repositoryUrl: remote, branch: "main", workspacePath, temporaryRoot: root, workspaceOwnership: "axiom-job", status: "failed", verificationPassed: true, pushSucceeded: false, remoteCommitConfirmed: false };
  return { root, remote, workspacePath, job };
}

test("reconciles a crash after local commit without creating a duplicate commit", async () => {
  const fixture = await makeRecoveryFixture("axiom-reconcile-local-");
  const { root, remote, workspacePath, job } = fixture;
  try {
    await fs.writeFile(path.join(workspacePath, "change.txt"), "one change\n");
    await git(workspacePath, ["add", "--all"]);
    await git(workspacePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "interrupted commit"]);
    const localBefore = (await git(workspacePath, ["rev-parse", "HEAD"])).stdout;
    const remoteBefore = (await git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout;
    const result = await reconcileRemoteWorkspace(job);
    assert.equal(result.state, "local-commit-pending-push");
    assert.equal(result.localSha, localBefore);
    assert.equal(result.remoteSha, remoteBefore);
    assert.equal((await git(workspacePath, ["rev-parse", "HEAD"])).stdout, localBefore);
    assert.equal((await git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout, remoteBefore);
    assert.equal(job.commitSha, localBefore);
    assert.equal(job.remoteCommitConfirmed, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reconciles a crash after push but before remote SHA confirmation", async () => {
  const fixture = await makeRecoveryFixture("axiom-reconcile-pushed-");
  const { root, remote, workspacePath, job } = fixture;
  try {
    await fs.writeFile(path.join(workspacePath, "change.txt"), "pushed change\n");
    await git(workspacePath, ["add", "--all"]);
    await git(workspacePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "pushed before crash"]);
    const localSha = (await git(workspacePath, ["rev-parse", "HEAD"])).stdout;
    await git(workspacePath, ["push", "origin", "HEAD:refs/heads/main"]);
    const result = await reconcileRemoteWorkspace(job);
    assert.equal(result.state, "already-pushed");
    assert.equal(result.localSha, localSha);
    assert.equal(result.remoteSha, localSha);
    assert.equal(job.status, "pushed");
    assert.equal(job.commitSha, localSha);
    assert.equal(job.remoteCommitConfirmed, true);
    assert.equal(job.pushSucceeded, true);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("detects independent remote advancement without overwriting either branch", async () => {
  const fixture = await makeRecoveryFixture("axiom-reconcile-drift-");
  const { root, remote, workspacePath, job } = fixture;
  const peer = path.join(root, "peer");
  try {
    const localSha = (await git(workspacePath, ["rev-parse", "HEAD"])).stdout;
    await git(root, ["clone", remote, peer]);
    await fs.writeFile(path.join(peer, "remote.txt"), "independent remote change\n");
    await git(peer, ["fetch", "origin", "main"]);
    await git(peer, ["add", "--all"]);
    await git(peer, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "independent remote change"]);
    await git(peer, ["push", "origin", "HEAD:refs/heads/main"]);
    const remoteSha = (await git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout;
    const result = await reconcileRemoteWorkspace(job);
    assert.equal(result.state, "remote-advanced");
    assert.equal(result.localSha, localSha);
    assert.equal(result.remoteSha, remoteSha);
    assert.equal((await git(workspacePath, ["rev-parse", "HEAD"])).stdout, localSha);
    assert.equal(job.remoteCommitConfirmed, false);
    assert.equal(job.pushSucceeded, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("refuses reconciliation when uncommitted changes or origin mismatch exist", async () => {
  const fixture = await makeRecoveryFixture("axiom-reconcile-unsafe-");
  const { root, workspacePath, job } = fixture;
  try {
    await fs.writeFile(path.join(workspacePath, "keep.txt"), "preserve me");
    const dirty = await reconcileRemoteWorkspace(job);
    assert.equal(dirty.state, "conflict");
    assert.match(dirty.reason, /uncommitted changes/);
    assert.equal(await fs.readFile(path.join(workspacePath, "keep.txt"), "utf8"), "preserve me");
    await fs.rm(path.join(workspacePath, "keep.txt"));
    await git(workspacePath, ["remote", "set-url", "origin", "https://github.com/other/repo.git"]);
    const mismatch = await reconcileRemoteWorkspace(job);
    assert.equal(mismatch.state, "conflict");
    assert.match(mismatch.reason, /origin does not match/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test("pushes a recovered local commit only after fresh verification", async () => {
  const fixture = await makeRecoveryFixture("axiom-reconcile-push-");
  const { root, remote, workspacePath, job } = fixture;
  try {
    await fs.writeFile(path.join(workspacePath, "recovered.txt"), "recover me\n");
    await git(workspacePath, ["add", "--all"]);
    await git(workspacePath, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "commit before crash"]);
    const localSha = (await git(workspacePath, ["rev-parse", "HEAD"])).stdout;
    await assert.rejects(() => pushReconciledWorkspace(job, { verify: async () => false }), /verification did not pass/);
    assert.equal((await git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout !== localSha, true);
    const result = await pushReconciledWorkspace(job, {
      verify: async directory => (await fs.readFile(path.join(directory, "recovered.txt"), "utf8")) === "recover me\n"
    });
    assert.equal(result.state, "pushed");
    assert.equal(result.commitSha, localSha);
    assert.equal((await git(root, ["--git-dir", remote, "rev-parse", "refs/heads/main"])).stdout, localSha);
    assert.equal(job.remoteCommitConfirmed, true);
    assert.equal(job.status, "pushed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("interrupted temporary cleanup is persisted and can be safely retried", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-cleanup-recovery-"));
  const workspacePath = path.join(root, "job-1");
  const states = [];
  try {
    await fs.mkdir(workspacePath, { recursive: true });
    await fs.writeFile(path.join(workspacePath, "result.txt"), "confirmed");
    const job = {
      mode: "temporary-full", workspaceOwnership: "axiom-job",
      temporaryRoot: root, workspacePath, status: "pushed",
      remoteCommitConfirmed: true, verificationPassed: true,
      pushSucceeded: true, commitSha: "a".repeat(40)
    };
    await assert.rejects(() => cleanupRemoteWorkspace(job, {
      onState: async current => states.push(current.status),
      remove: async () => { throw new Error("simulated interrupted filesystem cleanup"); }
    }), /cleanup was interrupted/);
    assert.equal(job.status, "cleanup-interrupted");
    assert.deepEqual(states, ["cleaning", "cleanup-interrupted"]);
    assert.equal(await fs.readFile(path.join(workspacePath, "result.txt"), "utf8"), "confirmed");

    const result = await cleanupRemoteWorkspace(job, {
      onState: async current => states.push(current.status)
    });
    assert.equal(result.cleaned, true);
    assert.equal(job.status, "cleaned");
    assert.deepEqual(states, ["cleaning", "cleanup-interrupted", "cleaning", "cleaned"]);
    await assert.rejects(() => fs.stat(workspacePath), { code: "ENOENT" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("cleanup remains forbidden for persistent or unconfirmed workspaces", async () => {
  const job = {
    mode: "persistent", workspaceOwnership: "user",
    workspacePath: "/tmp/user-checkout", status: "pushed",
    remoteCommitConfirmed: true, verificationPassed: true,
    pushSucceeded: true, commitSha: "b".repeat(40)
  };
  await assert.rejects(() => cleanupRemoteWorkspace(job), /Refusing cleanup/);
  assert.equal(job.status, "pushed");
});
