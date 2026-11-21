"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createDetachedWorktree } = require("./worker-worktree.cjs");
const { redactSecrets } = require("./security-redaction.cjs");
const execFileAsync = promisify(execFile);
const MAX_PATCH_BYTES = 8 * 1024 * 1024;

function canonicalRepositoryIdentity(value) {
  let candidate = String(value || "").trim();
  const scp = candidate.match(/^git@([^:]+):(.+)$/i);
  if (scp) candidate = "https://" + scp[1] + "/" + scp[2];
  if (/^ssh:\/\/git@/i.test(candidate)) candidate = candidate.replace(/^ssh:\/\/git@/i, "https://");
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Git remote must use HTTPS or SSH.");
  return (parsed.hostname + parsed.pathname.replace(/\.git$/i, "").replace(/\/+$/, "")).toLowerCase();
}

async function applyRemoteWorkerPatch(options = {}) {
  const workspaceRoot = typeof options.workspaceRoot === "string" ? options.workspaceRoot.trim() : "";
  const userDataPath = typeof options.userDataPath === "string" ? options.userDataPath.trim() : "";
  const taskId = String(options.taskId || "").trim();
  const jobId = String(options.jobId || "").trim();
  const patch = options.patch;
  if (!workspaceRoot || !userDataPath) throw new TypeError("Local project root and user data directory are required.");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(taskId)) throw new TypeError("Remote task ID is invalid.");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new TypeError("Remote job ID is invalid.");
  if (typeof patch !== "string" || !patch.length || Buffer.byteLength(patch, "utf8") > MAX_PATCH_BYTES || !/^diff --git /m.test(patch)) {
    throw new TypeError("Remote worker patch must contain Git file-change headers and be no larger than 8 MiB.");
  }
  const expected = canonicalRepositoryIdentity(options.repositoryUrl);
  const execute = options.execFile || execFileAsync;
  const remotes = await execute("git", ["remote", "-v"], {
    cwd: workspaceRoot, timeout: 15000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  const remoteUrls = String(remotes.stdout || "").split(/\r?\n/).map(line => line.trim().split(/\s+/)[1]).filter(Boolean);
  if (!remoteUrls.some(value => {
    try { return canonicalRepositoryIdentity(value) === expected; } catch { return false; }
  })) {
    throw new Error("Configured Worker Host repository does not match any Git remote in the currently open project.");
  }
  const importMapPath = path.join(userDataPath, "remote-worker-imports.json");
  let imported = {};
  try { imported = JSON.parse(await fs.readFile(importMapPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw new Error("Remote import history could not be read safely."); }
  const existingWorktree = imported[jobId];
  if (typeof existingWorktree === "string") {
    try { if ((await fs.stat(existingWorktree)).isDirectory()) return { worktreePath: existingWorktree, alreadyImported: true }; }
    catch { /* Recreate the review worktree if the previous one was removed. */ }
  }

  const createWorktree = options.createWorktree || createDetachedWorktree;
  const worktreePath = await createWorktree({ workspaceRoot, userDataPath, taskId: "remote-" + taskId });
  const patchDirectory = path.join(userDataPath, "remote-worker-patches");
  const patchFile = path.join(patchDirectory, crypto.randomUUID() + ".patch");
  try {
    await fs.mkdir(patchDirectory, { recursive: true, mode: 0o700 });
    await fs.writeFile(patchFile, patch, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await execute("git", ["apply", "--check", "--binary", patchFile], {
      cwd: worktreePath, timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    await execute("git", ["apply", "--binary", patchFile], {
      cwd: worktreePath, timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    });
    imported[jobId] = worktreePath;
    const temporaryMap = importMapPath + "." + process.pid + ".tmp";
    await fs.writeFile(temporaryMap, JSON.stringify(imported), { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporaryMap, importMapPath);
    return { worktreePath, alreadyImported: false };
  } catch (error) {
    try { await execute("git", ["-C", workspaceRoot, "worktree", "remove", "--force", worktreePath], { timeout: 30000, windowsHide: true }); } catch {}
    try { await fs.rm(worktreePath, { recursive: true, force: true }); } catch {}
    throw new Error("Remote patch could not be applied safely to the current local revision: " + redactSecrets(error.message || error).slice(0, 1200));
  } finally {
    try { await fs.unlink(patchFile); } catch {}
  }
}
module.exports = { applyRemoteWorkerPatch, canonicalRepositoryIdentity, MAX_PATCH_BYTES };
