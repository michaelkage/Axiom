"use strict";
const path = require("node:path");

const WORKSPACE_MODES = Object.freeze(["persistent", "temporary-full", "temporary-selective"]);
const TERMINAL_SUCCESS = new Set(["verified", "committed", "pushed"]);

function validateRepositoryUrl(repositoryUrl) {
  if (typeof repositoryUrl !== "string" || !repositoryUrl.trim() || /[\s\\\0]/.test(repositoryUrl)) {
    throw new TypeError("Repository URL must be a valid HTTPS or SSH remote.");
  }
  if (repositoryUrl.startsWith("git@")) {
    if (!/^git@[A-Za-z0-9.-]+:[^?#\\s]+$/.test(repositoryUrl) || repositoryUrl.includes("..")) {
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

module.exports = { WORKSPACE_MODES, validateRemoteWorkspaceRequest, normalizeRepositoryPath, mayCleanupRemoteWorkspace };
