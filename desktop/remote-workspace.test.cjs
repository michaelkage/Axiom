"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validateRemoteWorkspaceRequest, normalizeRepositoryPath, mayCleanupRemoteWorkspace } = require("./remote-workspace.cjs");

test("validates full and selective remote workspace requests", () => {
  assert.equal(validateRemoteWorkspaceRequest({ mode: "temporary-full", repositoryUrl: "https://github.com/acme/repo.git", branch: "feature/work" }).mode, "temporary-full");
  assert.deepEqual(validateRemoteWorkspaceRequest({ mode: "temporary-selective", repositoryUrl: "git@github.com:acme/repo.git", branch: "main", paths: ["src/a.ts", "src/../README.md", "src/a.ts"] }).paths, ["src/a.ts", "README.md"]);
  assert.throws(() => validateRemoteWorkspaceRequest({ mode: "temporary-selective", repositoryUrl: "https://github.com/acme/repo.git", branch: "main", paths: [] }), /requires at least one/);
  assert.throws(() => validateRemoteWorkspaceRequest({ mode: "temporary-full", repositoryUrl: "file:///etc/passwd", branch: "main" }), /HTTPS or SSH/);
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
