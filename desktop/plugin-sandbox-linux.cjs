"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const PLUGIN_MOUNT = "/opt/axiom-plugin";
const WORKSPACE_MOUNT = "/workspace";

function existingDirectory(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new TypeError(label + " must be an absolute path.");
  const resolved = fs.realpathSync(path.resolve(value));
  if (!fs.statSync(resolved).isDirectory()) throw new TypeError(label + " must be a directory.");
  return resolved;
}

function createLinuxBubblewrapAdapter(options = {}) {
  if (process.platform !== "linux") throw new Error("The bubblewrap plugin sandbox is supported only on Linux.");
  const bwrap = options.executable || "bwrap";
  const spawnProcess = options.spawn || spawn;

  function buildArgs(request) {
    if (!request || typeof request !== "object") throw new TypeError("Sandbox request is required.");
    if (typeof request.executable !== "string" || !path.isAbsolute(request.executable)) throw new TypeError("Plugin executable must be an absolute path.");
    if (!Array.isArray(request.args) || request.args.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new TypeError("Plugin arguments are invalid.");
    const pluginDir = existingDirectory(request.pluginRoot, "Plugin root");
    const cwd = request.cwd ? fs.realpathSync(path.resolve(request.cwd)) : pluginDir;
    if (cwd !== pluginDir && !cwd.startsWith(pluginDir + path.sep)) throw new Error("Plugin working directory escaped its installation root.");
    const workspace = request.workspaceRoot ? existingDirectory(request.workspaceRoot, "Workspace root") : null;
    const limits = request.limits || {};
    const capabilities = Array.isArray(limits.filesystem) ? limits.filesystem : [];
    const hasProjectAccess = capabilities.includes("project.read") || capabilities.includes("project.write");
    const writable = capabilities.includes("project.write");
    if (hasProjectAccess && !workspace) throw new Error("Project filesystem capability requires a workspace mount.");
    if (!hasProjectAccess && workspace) throw new Error("Workspace mount supplied without a project filesystem capability.");
    const relativeCwd = path.relative(pluginDir, cwd).split(path.sep).join("/");
    const sandboxCwd = relativeCwd ? PLUGIN_MOUNT + "/" + relativeCwd : PLUGIN_MOUNT;
    const mappedArgs = request.args.map(arg => {
      if (path.isAbsolute(arg) && (arg === pluginDir || arg.startsWith(pluginDir + path.sep))) {
        const relative = path.relative(pluginDir, arg).split(path.sep).join("/");
        return relative ? PLUGIN_MOUNT + "/" + relative : PLUGIN_MOUNT;
      }
      return arg;
    });
    const args = [
      "--die-with-parent", "--new-session", "--unshare-all",
      "--cap-drop", "ALL",
      "--rlimit-cpu", String(Math.ceil(Number(limits.timeoutMs || 30000) / 1000) + 1),
      "--rlimit-nproc", "64", "--rlimit-nofile", "128", "--rlimit-fsize", String(16 * 1024 * 1024),
      "--ro-bind", "/", "/",
      "--tmpfs", "/home", "--tmpfs", "/root", "--tmpfs", "/run",
      "--tmpfs", "/tmp",
      "--dir", PLUGIN_MOUNT,
      "--ro-bind", pluginDir, PLUGIN_MOUNT,
      "--proc", "/proc", "--dev", "/dev",
      "--chdir", sandboxCwd,
      "--clearenv", "--setenv", "PATH", DEFAULT_PATH,
      "--setenv", "HOME", "/tmp",
      "--setenv", "NODE_ENV", "production"
    ];
    if (limits.network === true) args.push("--share-net");
    if (workspace) {
      args.push("--dir", WORKSPACE_MOUNT, writable ? "--bind" : "--ro-bind", workspace, WORKSPACE_MOUNT);
    }
    for (const [key, value] of Object.entries(request.env || {})) {
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(key) || typeof value !== "string" || value.length > 4096 || value.includes("\0")) {
        throw new TypeError("Sandbox environment contains an invalid entry.");
      }
      args.push("--setenv", key, value);
    }
    args.push("--", request.executable, ...mappedArgs);
    return args;
  }

  function run(request) {
    const limits = request?.limits || {};
    const timeoutMs = Number(limits.timeoutMs);
    const stdoutLimit = Math.max(1024, Math.min(Number(limits.stdoutBytes) || 256 * 1024, 1024 * 1024));
    const stderrLimit = Math.max(1024, Math.min(Number(limits.stderrBytes) || 64 * 1024, 256 * 1024));
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new TypeError("Sandbox timeout is outside the supported range.");
    const args = buildArgs(request);
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(bwrap, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      } catch (error) {
        reject(error);
        return;
      }
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      let settled = false;
      let timedOut = false;
      let overflow = false;
      const append = (current, chunk, limit) => {
        const next = Buffer.concat([current, chunk]);
        if (next.length > limit) {
          overflow = true;
          child.kill("SIGKILL");
          return next.subarray(0, limit);
        }
        return next;
      };
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      timer.unref?.();
      child.stdout?.on("data", chunk => { stdout = append(stdout, chunk, stdoutLimit); });
      child.stderr?.on("data", chunk => { stderr = append(stderr, chunk, stderrLimit); });
      child.once("error", error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          exitCode: Number.isInteger(code) ? code : -1,
          signal: signal || null,
          timedOut,
          outputLimitExceeded: overflow,
          stdout: stdout.toString("utf8"),
          stderr: stderr.toString("utf8")
        });
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(typeof request.stdin === "string" ? request.stdin : "");
    });
  }

  return Object.freeze({ run, buildArgs });
}

function createPlatformPluginSandbox(options = {}) {
  if (process.platform === "linux") return createLinuxBubblewrapAdapter(options);
  throw new Error("No verified OS-level plugin sandbox is available for " + process.platform + "; plugin execution is disabled.");
}

module.exports = { createLinuxBubblewrapAdapter, createPlatformPluginSandbox, PLUGIN_MOUNT, WORKSPACE_MOUNT };
