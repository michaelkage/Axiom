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
    signal: options.signal,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", ...(options.env || {}) }
  });
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}
function throwIfAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("Remote workspace operation was cancelled.");
    error.name = "AbortError";
    throw error;
  }
}
async function createRemoteWorkspace(input, options = {}) {
  const request = validateRemoteWorkspaceRequest(input);
  safeRemoteUrl(request.repositoryUrl);
  const temporaryRoot = path.resolve(options.temporaryRoot || path.join(os.tmpdir(), "axiom-remote-workspaces"));
  await fs.mkdir(temporaryRoot, { recursive: true });
  const workspacePath = options.workspacePath
    ? path.resolve(options.workspacePath)
    : request.mode === "persistent"
      ? path.resolve(input.persistentPath || "")
      : path.join(temporaryRoot, randomUUID());
  if (request.mode === "persistent" && (!input.persistentPath || workspacePath === path.parse(workspacePath).root)) {
    throw new TypeError("Persistent mode requires an explicit, non-root workspace path.");
  }
  if (request.mode !== "persistent" && path.dirname(workspacePath) !== temporaryRoot) {
    throw new TypeError("Temporary workspace path must be a direct child of its managed root.");
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
    await execFileAsync("git", args, { timeout: options.cloneTimeout ?? 300000, signal: options.signal, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" } });
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
    if (request.mode !== "persistent" && path.dirname(workspacePath) === temporaryRoot) {
      try {
        const stat = await fs.lstat(workspacePath);
        if (stat.isDirectory() && !stat.isSymbolicLink()) {
          const [realRoot, realWorkspace] = await Promise.all([fs.realpath(temporaryRoot), fs.realpath(workspacePath)]);
          if (path.dirname(realWorkspace) === realRoot) await fs.rm(realWorkspace, { recursive: true, force: true });
        }
      } catch (cleanupError) {
        if (!cleanupError || cleanupError.code !== "ENOENT") {
          error.cleanupError = String(cleanupError.message || cleanupError).slice(0, 300);
        }
      }
    }
    throw new Error("Could not create remote workspace. Check repository access and configured Git credentials. " + String(error.message || error).replace(/https?:\/\/[^\s]+/g, "[repository URL redacted]").slice(0, 500) + (error.cleanupError ? " Cleanup warning: " + error.cleanupError : ""));
  }
}
async function commitAndPushWorkspace(job, options = {}) {
  throwIfAborted(options.signal);
  if (!job || !job.workspacePath || !job.branch || !job.repositoryUrl) throw new TypeError("A valid remote workspace job is required.");
  if (job.status !== "ready" && job.status !== "verified") throw new Error("Workspace must be ready or verified before committing.");
  if (typeof options.verify !== "function") throw new Error("An explicit verification callback is required before committing.");
  if (await options.verify(job.workspacePath, options.signal) !== true) {
    job.status = "failed"; job.verificationPassed = false;
    throw new Error("Workspace verification did not pass; refusing to commit or push.");
  }
  throwIfAborted(options.signal);
  job.verificationPassed = true;
  job.status = "verified";
  const directory = job.workspacePath;
  const status = await git(directory, ["status", "--porcelain"], { signal: options.signal });
  if (!status.stdout) throw new Error("No changes to commit.");
  const identityName = options.authorName || "Axiom";
  const identityEmail = options.authorEmail || "axiom@users.noreply.github.com";
  await git(directory, ["add", "--all"], { signal: options.signal });
  await git(directory, ["-c", "user.name=" + identityName, "-c", "user.email=" + identityEmail, "commit", "-m", options.message || "Apply changes with Axiom"], { signal: options.signal });
  const localSha = (await git(directory, ["rev-parse", "HEAD"], { signal: options.signal })).stdout;
  // Record the durable local commit before any cancellable push phase.
  job.commitSha = localSha;
  job.pushSucceeded = false;
  job.remoteCommitConfirmed = false;
  throwIfAborted(options.signal);
  await git(directory, ["push", "origin", "HEAD:refs/heads/" + job.branch], { timeout: options.pushTimeout ?? 120000, signal: options.signal });
  job.pushSucceeded = true;
  const remote = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, signal: options.signal, maxBuffer: 1024 * 1024, windowsHide: true,
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
  throwIfAborted(options.signal);
  if (!job || !job.workspacePath || !job.branch || !job.repositoryUrl) {
    throw new TypeError("A valid remote workspace job is required.");
  }
  if (job.status === "cleaned") throw new Error("A cleaned workspace cannot be reconciled.");
  const directory = job.workspacePath;
  const localSha = (await git(directory, ["rev-parse", "HEAD"], { signal: options.signal })).stdout;
  const branch = (await git(directory, ["branch", "--show-current"], { signal: options.signal })).stdout;
  if (branch !== job.branch) return { state: "conflict", reason: "The checkout is not on the job's target branch.", localSha, remoteSha: null };
  const dirty = (await git(directory, ["status", "--porcelain"], { signal: options.signal })).stdout;
  if (dirty) return { state: "conflict", reason: "The workspace has uncommitted changes; preserve them and resolve manually.", localSha, remoteSha: null, dirty: true };
  const origin = (await git(directory, ["remote", "get-url", "origin"], { signal: options.signal })).stdout;
  if (origin !== job.repositoryUrl) return { state: "conflict", reason: "The checkout origin does not match the persisted repository URL.", localSha, remoteSha: null };
  const remoteResult = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, signal: options.signal, maxBuffer: 1024 * 1024, windowsHide: true,
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
  throwIfAborted(options.signal);
  await git(directory, ["fetch", "--no-tags", "origin", "refs/heads/" + job.branch], { signal: options.signal });
  const remoteIsAncestor = await git(directory, ["merge-base", "--is-ancestor", remoteSha, localSha], { signal: options.signal }).then(() => true).catch(() => false);
  const localIsAncestor = await git(directory, ["merge-base", "--is-ancestor", localSha, remoteSha], { signal: options.signal }).then(() => true).catch(() => false);
  if (remoteIsAncestor) {
    const ahead = Number((await git(directory, ["rev-list", "--count", remoteSha + ".." + localSha], { signal: options.signal })).stdout);
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
  throwIfAborted(options.signal);
  if (typeof options.verify !== "function") throw new Error("A fresh verification callback is required before pushing a recovered commit.");
  const state = await reconcileRemoteWorkspace(job, options);
  if (state.state !== "local-commit-pending-push") throw new Error("Recovered commit is not safely pushable: " + state.state + ".");
  if (await options.verify(job.workspacePath, options.signal) !== true) throw new Error("Workspace verification did not pass; refusing to push the recovered commit.");
  const verifiedLocalSha = (await git(job.workspacePath, ["rev-parse", "HEAD"], { signal: options.signal })).stdout;
  const verifiedStatus = (await git(job.workspacePath, ["status", "--porcelain"], { signal: options.signal })).stdout;
  if (verifiedLocalSha !== state.localSha || verifiedStatus) throw new Error("The local checkout changed during verification; refusing to push.");
  const currentRemote = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, signal: options.signal, maxBuffer: 1024 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never" }
  });
  const remoteSha = currentRemote.stdout.trim().split(/\s+/)[0] || "";
  if (remoteSha !== state.remoteSha) throw new Error("Remote branch changed during recovery verification; refusing to push.");
  throwIfAborted(options.signal);
  await git(job.workspacePath, ["push", "origin", "HEAD:refs/heads/" + job.branch], { timeout: options.pushTimeout ?? 120000, signal: options.signal });
  const confirmed = await execFileAsync("git", ["ls-remote", "--exit-code", "--heads", job.repositoryUrl, "refs/heads/" + job.branch], {
    timeout: options.verifyRemoteTimeout ?? 60000, signal: options.signal, maxBuffer: 1024 * 1024, windowsHide: true,
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
async function discardInterruptedCloneWorkspace(job) {
  if (!job || job.mode === "persistent" || job.workspaceOwnership !== "axiom-job" ||
      typeof job.temporaryRoot !== "string" || typeof job.workspacePath !== "string") {
    return { removed: false, preserved: true };
  }
  const root = path.resolve(job.temporaryRoot);
  const workspace = path.resolve(job.workspacePath);
  if (path.dirname(workspace) !== root) throw new Error("Refusing interrupted clone cleanup: workspace is not a direct child of its managed root.");
  let rootStat;
  try { rootStat = await fs.lstat(root); }
  catch (error) {
    if (error && error.code === "ENOENT") return { removed: false, alreadyAbsent: true };
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Refusing interrupted clone cleanup: managed root is not a real directory.");
  let stat;
  try { stat = await fs.lstat(workspace); }
  catch (error) {
    if (error && error.code === "ENOENT") return { removed: false, alreadyAbsent: true };
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Refusing interrupted clone cleanup: partial checkout is not a real directory.");
  const [realRoot, realWorkspace] = await Promise.all([fs.realpath(root), fs.realpath(workspace)]);
  if (path.dirname(realWorkspace) !== realRoot) throw new Error("Refusing interrupted clone cleanup: resolved checkout escapes its managed root.");
  await fs.rm(realWorkspace, { recursive: true, force: false });
  return { removed: true };
}
async function assertOwnedTemporaryWorkspace(job) {
  if (!mayCleanupRemoteWorkspace(job)) {
    throw new Error("Refusing cleanup: remote commit, verification, push, and job-owned temporary workspace must all be confirmed.");
  }
  const root = path.resolve(job.temporaryRoot);
  const workspace = path.resolve(job.workspacePath);
  // Jobs are created as direct children of Axiom's managed root. Requiring
  // that exact relationship prevents prefix tricks and nested-path surprises.
  if (path.dirname(workspace) !== root) throw new Error("Refusing cleanup: workspace is not a direct child of its managed temporary root.");
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("Refusing cleanup: managed temporary root is not a real directory.");
  let workspaceStat;
  try { workspaceStat = await fs.lstat(workspace); }
  catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()) throw new Error("Refusing cleanup: workspace is not a real directory.");
  const [realRoot, realWorkspace] = await Promise.all([fs.realpath(root), fs.realpath(workspace)]);
  const relative = path.relative(realRoot, realWorkspace);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.dirname(relative) !== ".") {
    throw new Error("Refusing cleanup: resolved workspace escapes the managed temporary root.");
  }
  return workspace;
}
async function cleanupRemoteWorkspace(job, options = {}) {
  const ownedWorkspace = await assertOwnedTemporaryWorkspace(job);
  if (!ownedWorkspace) {
    // A previous process may have removed the directory and crashed before
    // persisting "cleaned". Treat that exact, already-absent owned path as done.
    job.status = "cleaned";
    if (typeof options.onState === "function") await options.onState(job);
    return { cleaned: true, commitSha: job.commitSha };
  }
  // Persist intent before touching disk. If the process exits mid-removal, the
  // restored job remains eligible for an idempotent cleanup retry.
  job.status = "cleaning";
  if (typeof options.onState === "function") await options.onState(job);
  try {
    const remove = options.remove || fs.rm;
    // Revalidate immediately before deletion; never follow a replaced symlink.
    const workspace = await assertOwnedTemporaryWorkspace(job);
    if (workspace) await remove(workspace, { recursive: true, force: true });
    job.status = "cleaned";
    if (typeof options.onState === "function") await options.onState(job);
    return { cleaned: true, commitSha: job.commitSha };
  } catch (error) {
    job.status = "cleanup-interrupted";
    if (typeof options.onState === "function") await options.onState(job).catch(() => undefined);
    throw new Error("Workspace cleanup was interrupted; its confirmed commit is preserved and cleanup can be retried. " + String(error.message || error).slice(0, 300));
  }
}
module.exports = { throwIfAborted, createRemoteWorkspace, commitAndPushWorkspace, reconcileRemoteWorkspace, pushReconciledWorkspace, cleanupRemoteWorkspace, safeRemoteUrl, git, assertOwnedTemporaryWorkspace, discardInterruptedCloneWorkspace };
