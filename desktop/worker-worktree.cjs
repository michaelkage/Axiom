"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const defaultExecFile = promisify(execFile);

async function createDetachedWorktree(options) {
  const workspaceRoot = typeof options?.workspaceRoot === "string" ? options.workspaceRoot.trim() : "";
  const userDataPath = typeof options?.userDataPath === "string" ? options.userDataPath.trim() : "";
  if (!workspaceRoot || !userDataPath) throw new TypeError("Workspace root and user data path are required.");

  const execute = options.execFile ?? defaultExecFile;
  const now = options.now ?? Date.now;
  const createId = options.createId ?? crypto.randomUUID;
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const rootResult = await execute("git", ["-C", resolvedWorkspace, "rev-parse", "--show-toplevel"], {
    timeout: 15000,
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  const rootOutput = typeof rootResult.stdout === "string" ? rootResult.stdout.trim() : "";
  if (!rootOutput) throw new Error("Git returned an empty repository root.");
  const repositoryRoot = path.resolve(rootOutput);
  const safeId = String(options.taskId || "task").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "task";
  const worktreeBase = path.join(path.resolve(userDataPath), "worktrees", path.basename(repositoryRoot));
  await fs.mkdir(worktreeBase, { recursive: true });

  const uniqueId = String(createId()).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  if (!uniqueId) throw new Error("Could not generate a unique worker worktree identifier.");
  const worktreePath = path.join(worktreeBase, safeId + "-" + now() + "-" + uniqueId);
  await execute("git", ["-C", repositoryRoot, "worktree", "add", "--detach", worktreePath, "HEAD"], {
    cwd: repositoryRoot,
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return worktreePath;
}

module.exports = { createDetachedWorktree };
