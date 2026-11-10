"use strict";
const path = require("node:path");

const WORKSPACE_MODES = Object.freeze(["persistent", "temporary-full", "temporary-selective"]);
const TERMINAL_SUCCESS = new Set(["verified", "committed", "pushed"]);

function validateRepositoryUrl(repositoryUrl) {
  if (typeof repositoryUrl !== "string" || !repositoryUrl.trim() || /[\s\\\0]/.test(repositoryUrl)) {
    throw new TypeError("Repository URL must be a valid HTTPS or SSH remote.");
  }
  if (repositoryUrl.startsWith("git@")) {
    if (!/^git@[A-Za-z0-9.-]+:[^?#\s]+$/.test(repositoryUrl) || repositoryUrl.includes("..")) {
      throw new TypeError("SSH repository URL must use git@host:path syntax without query parameters or fragments.");
    }
    return repositoryUrl;
  }
  let url;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new TypeError("Repository URL must be a valid HTTPS or SSH remote.");
  }
  if (url.protocol !== "https:" && url.protocol !== "ssh:") {
    throw new TypeError("Repository URL must use HTTPS or SSH.");
  }
  if (!url.hostname || url.password || url.search || url.hash || (url.protocol === "https:" && url.username)) {
    throw new TypeError("Repository URL must not contain embedded credentials, query parameters, or fragments.");
  }
  return repositoryUrl;
}

function validateRemoteWorkspaceRequest(request) {
  if (!request || typeof request !== "object") throw new TypeError("A remote workspace request is required.");
  if (!WORKSPACE_MODES.includes(request.mode)) throw new TypeError("Unsupported remote workspace mode.");
  validateRepositoryUrl(request.repositoryUrl);
  if (typeof request.branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(request.branch) || request.branch.includes("..") || request.branch.endsWith("/") || request.branch.endsWith(".lock")) {
    throw new TypeError("A valid target branch is required.");
  }
  if (request.mode === "temporary-selective" && (!Array.isArray(request.paths) || request.paths.length === 0)) {
    throw new TypeError("Selective workspace mode requires at least one repository-relative path.");
  }
  const paths = (request.paths ?? []).map(normalizeRepositoryPath);
  return { mode: request.mode, repositoryUrl: request.repositoryUrl, branch: request.branch, paths: [...new Set(paths)] };
}

function normalizeRepositoryPath(input) {
  if (typeof input !== "string" || !input.trim() || input.includes("\0") || input.includes("\\")) throw new TypeError("Repository paths must be non-empty relative POSIX paths.");
  const normalized = path.posix.normalize(input.trim());
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new TypeError("Repository path escapes the checkout root.");
  }
  return normalized;
}

/** Cleanup is permitted only for a job-owned temporary directory after the remote ref confirms the pushed commit. */
function mayCleanupRemoteWorkspace(job) {
  if (!job || job.mode === "persistent") return false;
  if (job.workspaceOwnership !== "axiom-job") return false;
  if (!job.workspacePath || !job.temporaryRoot) return false;
  const root = path.resolve(job.temporaryRoot);
  const workspace = path.resolve(job.workspacePath);
  if (workspace === root || !workspace.startsWith(root + path.sep)) return false;
  if (!TERMINAL_SUCCESS.has(job.status) || job.remoteCommitConfirmed !== true) return false;
  if (job.verificationPassed !== true || job.pushSucceeded !== true) return false;
  return true;
}

/** Validate persisted metadata before it can re-enter the in-memory job registry. */
function restoreRemoteWorkspaceJob(job, managedRoot) {
  try {
    if (!job || typeof job !== "object" || typeof job.id !== "string" || !/^[0-9a-f-]{36}$/i.test(job.id)) return null;
    const request = validateRemoteWorkspaceRequest({ mode: job.mode, repositoryUrl: job.repositoryUrl, branch: job.branch, paths: job.paths ?? [] });
    const statuses = new Set(["ready", "verified", "pushed", "failed"]);
    if (!statuses.has(job.status)) return null;
    if (typeof job.workspacePath !== "string" || !job.workspacePath.trim()) return null;
    const workspacePath = path.resolve(job.workspacePath);
    const flags = {
      remoteCommitConfirmed: job.remoteCommitConfirmed === true,
      verificationPassed: job.verificationPassed === true,
      pushSucceeded: job.pushSucceeded === true
    };
    if (job.remoteCommitConfirmed != null && typeof job.remoteCommitConfirmed !== "boolean") return null;
    if (job.verificationPassed != null && typeof job.verificationPassed !== "boolean") return null;
    if (job.pushSucceeded != null && typeof job.pushSucceeded !== "boolean") return null;
    if (flags.remoteCommitConfirmed && (!flags.verificationPassed || !flags.pushSucceeded || typeof job.commitSha !== "string" || !/^[0-9a-f]{40,64}$/i.test(job.commitSha))) return null;
    if (job.mode === "persistent") {
      if (job.workspaceOwnership !== "user") return null;
      return { ...job, ...request, workspacePath, temporaryRoot: null, workspaceOwnership: "user", ...flags, commitSha: job.commitSha || null };
    }
    if (job.workspaceOwnership !== "axiom-job" || typeof managedRoot !== "string" || !managedRoot.trim()) return null;
    const root = path.resolve(managedRoot);
    const storedRoot = typeof job.temporaryRoot === "string" ? path.resolve(job.temporaryRoot) : "";
    if (storedRoot !== root || workspacePath === root || !workspacePath.startsWith(root + path.sep)) return null;
    return { ...job, ...request, workspacePath, temporaryRoot: root, workspaceOwnership: "axiom-job", ...flags, commitSha: job.commitSha || null };
  } catch {
    return null;
  }
}

module.exports = { WORKSPACE_MODES, validateRemoteWorkspaceRequest, normalizeRepositoryPath, mayCleanupRemoteWorkspace, restoreRemoteWorkspaceJob };
