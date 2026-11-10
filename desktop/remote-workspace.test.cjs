"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { validateRemoteWorkspaceRequest, normalizeRepositoryPath, mayCleanupRemoteWorkspace, restoreRemoteWorkspaceJob } = require("./remote-workspace.cjs");

test("validates full and selective remote workspace requests", () => {
  assert.equal(validateRemoteWorkspaceRequest({ mode: "temporary-full", repositoryUrl: "https://github.com/acme/repo.git", branch: "feature/work" }).mode, "temporary-full");
  assert.deepEqual(validateRemoteWorkspaceRequest({ mode: "temporary-selective", repositoryUrl: "git@github.com:acme/repo.git", branch: "main", paths: ["src/a.ts", "src/../README.md", "src/a.ts"] }).paths, ["src/a.ts", "README.md"]);
  assert.throws(() => validateRemoteWorkspaceRequest({ mode: "temporary-selective", repositoryUrl: "https://github.com/acme/repo.git", branch: "main", paths: [] }), /requires at least one/);
  assert.throws(() => validateRemoteWorkspaceRequest({ mode: "temporary-full", repositoryUrl: "file:///etc/passwd", branch: "main" }), /HTTPS or SSH/);
  for (const repositoryUrl of [
    "https://user:token@github.com/acme/repo.git",
    "https://github.com/acme/repo.git?token=secret",
    "https://github.com/acme/repo.git#fragment",
    "https://github.com/acme/repo.git\\n--upload-pack=evil",
    "https://github.com/acme/repo.git\\\\n",
    "https://github.com/acme/repo.git\nextra",
    "git@github.com:acme/repo.git?token=secret",
    "git@github.com:acme/repo.git extra",
    "https://github.com\\\\acme\\\\repo.git"
  ]) {
    assert.throws(() => validateRemoteWorkspaceRequest({ mode: "temporary-full", repositoryUrl, branch: "main" }), /Repository URL|SSH repository URL/);
  }
});

test("rejects traversal and unsafe repository paths", () => {
  assert.throws(() => normalizeRepositoryPath("../../outside"), /escapes/);
  assert.throws(() => normalizeRepositoryPath("/etc/passwd"), /escapes/);
  assert.throws(() => normalizeRepositoryPath("C:\\temp\\secret"), /relative POSIX/);
});

test("temporary cleanup requires verified push and a job-owned nested directory", () => {
  const base = { mode: "temporary-full", workspaceOwnership: "axiom-job", temporaryRoot: "/tmp/axiom-jobs", workspacePath: "/tmp/axiom-jobs/job-1", status: "pushed", verificationPassed: true, pushSucceeded: true, remoteCommitConfirmed: true };
  assert.equal(mayCleanupRemoteWorkspace(base), true);
  assert.equal(mayCleanupRemoteWorkspace({ ...base, remoteCommitConfirmed: false }), false);
  assert.equal(mayCleanupRemoteWorkspace({ ...base, verificationPassed: false }), false);
  assert.equal(mayCleanupRemoteWorkspace({ ...base, workspaceOwnership: "user" }), false);
  assert.equal(mayCleanupRemoteWorkspace({ ...base, workspacePath: "/tmp/axiom-jobs" }), false);
  assert.equal(mayCleanupRemoteWorkspace({ ...base, mode: "persistent" }), false);
  assert.equal(mayCleanupRemoteWorkspace({ ...base, status: "failed" }), false);
});


test("restores only valid persisted remote jobs inside the managed workspace root", () => {
  const root = "/var/lib/axiom/remote-workspaces";
  const valid = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    mode: "temporary-full",
    repositoryUrl: "https://github.com/acme/repo.git",
    branch: "feature/work",
    paths: [],
    workspacePath: root + "/job-1",
    temporaryRoot: root,
    workspaceOwnership: "axiom-job",
    status: "pushed",
    remoteCommitConfirmed: true,
    verificationPassed: true,
    pushSucceeded: true,
    commitSha: "a".repeat(40)
  };
  const restored = restoreRemoteWorkspaceJob(valid, root);
  assert.equal(restored.id, valid.id);
  assert.equal(restored.status, "pushed");
  assert.equal(restored.remoteCommitConfirmed, true);
  assert.equal(restoreRemoteWorkspaceJob({ ...valid, workspacePath: root + "-evil/job-1" }, root), null);
  assert.equal(restoreRemoteWorkspaceJob({ ...valid, temporaryRoot: "/tmp/other-root" }, root), null);
  assert.equal(restoreRemoteWorkspaceJob({ ...valid, mode: "unknown" }, root), null);
  assert.equal(restoreRemoteWorkspaceJob({ ...valid, remoteCommitConfirmed: true, verificationPassed: false }, root), null);
  assert.equal(restoreRemoteWorkspaceJob({ ...valid, commitSha: "not-a-sha" }, root), null);
  assert.equal(restoreRemoteWorkspaceJob({ ...valid, status: "running" }, root), null);
});

test("restores persistent user-owned workspaces without granting cleanup ownership", () => {
  const job = restoreRemoteWorkspaceJob({
    id: "123e4567-e89b-12d3-a456-426614174000",
    mode: "persistent",
    repositoryUrl: "https://github.com/acme/repo.git",
    branch: "main",
    paths: [],
    workspacePath: "/home/user/projects/repo",
    workspaceOwnership: "user",
    status: "ready"
  }, "/var/lib/axiom/remote-workspaces");
  assert.equal(job.workspacePath, path.resolve("/home/user/projects/repo"));
  assert.equal(job.workspaceOwnership, "user");
  assert.equal(job.temporaryRoot, null);
  assert.equal(mayCleanupRemoteWorkspace(job), false);
  assert.equal(restoreRemoteWorkspaceJob({
    id: "123e4567-e89b-12d3-a456-426614174000",
    mode: "persistent",
    repositoryUrl: "https://github.com/acme/repo.git",
    branch: "main",
    workspacePath: "/home/user/projects/repo",
    workspaceOwnership: "axiom-job",
    status: "ready"
  }, "/var/lib/axiom/remote-workspaces"), null);
});
