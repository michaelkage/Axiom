"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { validateRemoteWorkspaceRequest, mayCleanupRemoteWorkspace } = require("./remote-workspace.cjs");
const execFileAsync = promisify(execFile);

function safeRemoteUrl(value) {
  if (typeof value !== "string" || !value.trim() || /[\s\\\0]/.test(value)) {
    throw new TypeError("Repository URL must be a valid HTTPS or SSH remote.");
  }
  // Git's SCP-style SSH syntax is not a URL, so validate it separately.
  if (value.startsWith("git@")) {
    if (!/^git@[A-Za-z0-9.-]+:[^?#\s]+$/.test(value) || value.includes("..")) {
      throw new TypeError("SSH repository URL must use git@host:path syntax without query parameters or fragments.");
    }
    return value;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Repository URL must be a valid HTTPS or SSH remote.");
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new TypeError("Repository URL must use HTTPS or SSH.");
  }
  if (!url.hostname || url.password || url.search || url.hash || (url.protocol === "https:" && url.username)) {
    throw new TypeError("Repository URL must not contain embedded credentials, query parameters, or fragments. Configure Git credentials or an SSH agent instead.");
  }
  return value;
}
async function git(directory, args, options = {}) {
  const result = await execFileAsync("git", ["-C", directory, ...args], {
    timeout: options.timeout ?? 120000,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", ...(options.env || {}) }
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
async function createRemoteWorkspace(input, options = {}) {
  const request = validateRemoteWorkspaceRequest(input);
  safeRemoteUrl(request.repositoryUrl);
  const temporaryRoot = path.resolve(options.temporaryRoot || path.join(os.tmpdir(), "axiom-remote-workspaces"));
  await fs.mkdir(temporaryRoot, { recursive: true });
  const workspacePath = request.mode === "persistent"
    ? path.resolve(input.persistentPath || "")
    : path.join(temporaryRoot, randomUUID());
  if (request.mode === "persistent" && (!input.persistentPath || workspacePath === path.parse(workspacePath).root)) {
    throw new TypeError("Persistent mode requires an explicit, non-root workspace path.");
  }
  await fs.mkdir(path.dirname(workspacePath), { recursive: true });
  if (request.mode === "persistent") {
    try {
      const stat = await fs.stat(workspacePath);
      if (!stat.isDirectory()) throw new Error("Destination exists and is not a directory.");
      const gitStat = await fs.stat(path.join(workspacePath, ".git")).catch(() => null);
      if (!gitStat || !gitStat.isDirectory()) throw new Error("Persistent destination exists but is not a Git checkout. Choose an empty path to avoid overwriting user files.");
      const remote = (await git(workspacePath, ["remote", "get-url", "origin"])).stdout;
      if (remote !== request.repositoryUrl) throw new Error("Persistent checkout origin does not match the requested repository.");
      const branch = (await git(workspacePath, ["branch", "--show-current"])).stdout;
      if (branch !== request.branch) throw new Error("Persistent checkout is on branch " + (branch || "(detached HEAD)") + ", not requested branch " + request.branch + ". Switch branches explicitly before reuse.");
      const status = (await git(workspacePath, ["status", "--porcelain"])).stdout;
      if (status) throw new Error("Persistent checkout has uncommitted changes. Commit or stash them before reuse; Axiom will not overwrite them.");
      return { mode: request.mode, repositoryUrl: request.repositoryUrl, branch: request.branch, paths: request.paths, workspacePath, temporaryRoot, workspaceOwnership: "user", status: "ready", remoteCommitConfirmed: false, verificationPassed: false, pushSucceeded: false, reusedExistingCheckout: true };
    } catch (error) {
      if (error && error.code === "ENOENT") { /* Destination does not exist; clone below. */ }
      else throw new Error("Could not reuse persistent workspace safely: " + String(error.message || error).slice(0, 500));
    }
  }
  try {
    const args = ["clone", "--no-tags", "--branch", request.branch];
    if (request.mode === "temporary-selective") args.push("--filter=blob:none", "--sparse");
    args.push("--", request.repositoryUrl, workspacePath);
    await execFileAsync("git", args, { timeout: options.cloneTimeout ?? 300000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } });
    if (request.mode === "temporary-selective") {
      await git(workspacePath, ["sparse-checkout", "set", "--", ...request.paths]);
    }
    return {
      mode: request.mode, repositoryUrl: request.repositoryUrl, branch: request.branch,
      paths: request.paths, workspacePath, temporaryRoot,
      workspaceOwnership: request.mode === "persistent" ? "user" : "axiom-job",
      status: "ready", remoteCommitConfirmed: false, verificationPassed: false, pushSucceeded: false
    };
  } catch (error) {
    if (request.mode !== "persistent" && workspacePath.startsWith(temporaryRoot + path.sep)) {
      await fs.rm(workspacePath, { recursive: true, force: true }).catch(() => undefined);
    }
    throw new Error("Could not create remote workspace. Check repository access and configured Git credentials. " + String(error.message || error).replace(/https?:\/\/[^\s]+/g, "[repository URL redacted]").slice(0, 500));
  }
}
async function commitAndPushWorkspace(job, options = {}) {
  if (!job || !job.workspacePath || !job.branch || !job.repositoryUrl) throw new TypeError("A valid remote workspace job is required.");
  if (job.status !== "ready" && job.status !== "verified") throw new Error("Workspace must be ready or verified before committing.");
  if (typeof options.verify !== "function") throw new Error("An explicit verification callback is required before committing.");
  if (await options.verify(job.workspacePath) !== true) {
    job.status = "failed"; job.verificationPassed = false;
    throw new Error("Workspace verification did not pass; refusing to commit or push.");
  }
  job.verificationPassed = true;
  job.status = "verified";
  const directory = job.workspacePath;
  const status = await git(directory, ["status", "--porcelain"]);
  if (!status.stdout) throw new Error("No changes to commit.");
  const identityName = options.authorName || "Axiom";
  const identityEmail = options.authorEmail || "axiom@users.noreply.github.com";
  await git(directory, ["add", "--all"]);
  await git(directory, ["-c", "user.name=" + identityName, "-c", "user.email=" + identityEmail, "commit", "-m", options.message || "Apply changes with Axiom"]);
  const localSha = (await git(directory, ["rev-parse", "HEAD"])).stdout;
  await git(directory, ["push", "origin", "HEAD:refs/heads/" + job.branch], { timeout: options.pushTimeout ?? 120000 });
  job.pushSucceeded = true;
  const remote = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
  });
  const remoteSha = (remote.stdout.trim().split(/\s+/)[0] || "");
  if (remoteSha !== localSha) {
    job.status = "failed"; job.remoteCommitConfirmed = false;
    throw new Error("Push completed but the remote branch did not confirm the expected commit. Workspace retained for recovery.");
  }
  job.remoteCommitConfirmed = true;
  job.commitSha = localSha;
  job.status = "pushed";
  return { commitSha: localSha, branch: job.branch, status: job.status };
}
/**
 * Inspect local and remote refs after an interrupted commit/push. This function
 * never creates commits, pushes, fetches, resets, or changes the checkout.
 */
async function reconcileRemoteWorkspace(job, options = {}) {
  if (!job || !job.workspacePath || !job.branch || !job.repositoryUrl) {
    throw new TypeError("A valid remote workspace job is required.");
  }
  if (job.status === "cleaned") throw new Error("A cleaned workspace cannot be reconciled.");
  const directory = job.workspacePath;
  const localSha = (await git(directory, ["rev-parse", "HEAD"])).stdout;
  const branch = (await git(directory, ["branch", "--show-current"])).stdout;
  if (branch !== job.branch) return { state: "conflict", reason: "The checkout is not on the job's target branch.", localSha, remoteSha: null };
  const dirty = (await git(directory, ["status", "--porcelain"])).stdout;
  if (dirty) return { state: "conflict", reason: "The workspace has uncommitted changes; preserve them and resolve manually.", localSha, remoteSha: null, dirty: true };
  const origin = (await git(directory, ["remote", "get-url", "origin"])).stdout;
  if (origin !== job.repositoryUrl) return { state: "conflict", reason: "The checkout origin does not match the persisted repository URL.", localSha, remoteSha: null };
  const remoteResult = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
  });
  const remoteSha = remoteResult.stdout.trim().split(/\s+/)[0] || "";
  if (!/^[0-9a-f]{40,64}$/i.test(remoteSha)) return { state: "conflict", reason: "The remote branch did not return a valid commit SHA.", localSha, remoteSha: null };
  if (localSha === remoteSha) {
    job.commitSha = localSha;
    job.remoteCommitConfirmed = true;
    job.pushSucceeded = true;
    job.status = "pushed";
    return { state: "already-pushed", localSha, remoteSha, dirty: !!dirty };
  }
  await git(directory, ["fetch", "--no-tags", "origin", "refs/heads/" + job.branch]);
  const remoteIsAncestor = await git(directory, ["merge-base", "--is-ancestor", remoteSha, localSha]).then(() => true).catch(() => false);
  const localIsAncestor = await git(directory, ["merge-base", "--is-ancestor", localSha, remoteSha]).then(() => true).catch(() => false);
  if (remoteIsAncestor) {
    const ahead = Number((await git(directory, ["rev-list", "--count", remoteSha + ".." + localSha])).stdout);
    if (ahead === 1 && !dirty) {
      job.commitSha = localSha;
      job.remoteCommitConfirmed = false;
      job.pushSucceeded = false;
      job.status = "verified";
      return { state: "local-commit-pending-push", localSha, remoteSha, dirty: false, pushAllowed: job.verificationPassed === true };
    }
    return { state: "conflict", reason: dirty ? "The workspace has uncommitted changes." : "The local branch contains multiple commits not present remotely; automatic recovery is ambiguous.", localSha, remoteSha, dirty: !!dirty };
  }
  if (localIsAncestor) {
    return { state: "remote-advanced", reason: "The remote branch advanced independently; no push or reset was attempted.", localSha, remoteSha, dirty: !!dirty };
  }
  return { state: "diverged", reason: "Local and remote branches have diverged; manual conflict resolution is required.", localSha, remoteSha, dirty: !!dirty };
}
/** Explicitly push a previously committed, single-commit recovery after fresh verification. */
async function pushReconciledWorkspace(job, options = {}) {
  if (typeof options.verify !== "function") throw new Error("A fresh verification callback is required before pushing a recovered commit.");
  const state = await reconcileRemoteWorkspace(job, options);
  if (state.state !== "local-commit-pending-push") throw new Error("Recovered commit is not safely pushable: " + state.state + ".");
  if (await options.verify(job.workspacePath) !== true) throw new Error("Workspace verification did not pass; refusing to push the recovered commit.");
  const currentRemote = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
  });
  const remoteSha = currentRemote.stdout.trim().split(/\s+/)[0] || "";
  if (remoteSha !== state.remoteSha) throw new Error("Remote branch changed during recovery verification; refusing to push.");
  await git(job.workspacePath, ["push", "origin", "HEAD:refs/heads/" + job.branch], { timeout: options.pushTimeout ?? 120000 });
  const confirmed = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", ...(options.env || {}) }
  });
  const confirmedSha = confirmed.stdout.trim().split(/\s+/)[0] || "";
  if (confirmedSha !== state.localSha) throw new Error("Push did not confirm the recovered commit SHA; workspace retained for manual recovery.");
  job.commitSha = state.localSha;
  job.verificationPassed = true;
  job.pushSucceeded = true;
  job.remoteCommitConfirmed = true;
  job.status = "pushed";
  return { state: "pushed", commitSha: state.localSha, branch: job.branch };
}
async function cleanupRemoteWorkspace(job) {
  if (!mayCleanupRemoteWorkspace(job)) throw new Error("Refusing cleanup: remote commit, verification, push, and job-owned temporary workspace must all be confirmed.");
  await fs.rm(job.workspacePath, { recursive: true, force: false });
  job.status = "cleaned";
  return { cleaned: true, commitSha: job.commitSha };
}
module.exports = { createRemoteWorkspace, commitAndPushWorkspace, reconcileRemoteWorkspace, pushReconciledWorkspace, cleanupRemoteWorkspace, safeRemoteUrl, git };
