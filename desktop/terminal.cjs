"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

const MAX_COMMAND_LENGTH = 10000;
const MAX_CONCURRENT_COMMANDS = 4;

function createTerminalRunner({ workspaceRoot, platform = process.platform, spawnProcess = spawn }) {
  const root = path.resolve(workspaceRoot);
  const processes = new Map();

  function resolveCwd(relative = "") {
    if (typeof relative !== "string" || relative.includes("\0")) {
      throw new Error("Terminal working directory must be a relative project path.");
    }
    if (path.isAbsolute(relative)) throw new Error("Terminal working directory must stay inside the project.");
    const candidate = path.resolve(root, relative || ".");
    const rel = path.relative(root, candidate);
    if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
      throw new Error("Terminal working directory must stay inside the project.");
    }
    let realRoot;
    let realCandidate;
    try {
      realRoot = fs.realpathSync(root);
      realCandidate = fs.realpathSync(candidate);
    } catch {
      throw new Error("Terminal working directory must exist inside the project.");
    }
    const realRelative = path.relative(realRoot, realCandidate);
    if (realRelative === ".." || realRelative.startsWith(".." + path.sep) || path.isAbsolute(realRelative)) {
      throw new Error("Terminal working directory must stay inside the project, including through symbolic links.");
    }
    if (!fs.statSync(realCandidate).isDirectory()) throw new Error("Terminal working directory must be a directory.");
    return realCandidate;
  }

  function run({ requestId, command, cwd = "", onOutput = () => {} }) {
    if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(requestId)) {
      throw new Error("Invalid terminal request ID.");
    }
    if (typeof command !== "string" || !command.trim() || command.length > MAX_COMMAND_LENGTH) {
      throw new Error("Enter a command of 1 to 10000 characters.");
    }
    if (processes.has(requestId)) throw new Error("That terminal request is already running.");
    if (processes.size >= MAX_CONCURRENT_COMMANDS) throw new Error("Axiom allows up to four terminal commands at once.");
    const directory = resolveCwd(cwd);
    const shell = platform === "win32" ? "powershell.exe" : (process.env.SHELL || "/bin/bash");
    const args = platform === "win32"
      ? ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
      : ["-lc", command];
    const child = spawnProcess(shell, args, {
      cwd: directory,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      ...(platform === "win32" ? {} : { detached: true }),
      env: process.env
    });
    processes.set(requestId, child);
    const emit = (stream, chunk) => {
      try { onOutput({ stream, text: String(chunk).slice(0, 100000) }); } catch { /* UI listeners must not break the command. */ }
    };
    child.stdout?.on("data", chunk => emit("stdout", chunk.toString()));
    child.stderr?.on("data", chunk => emit("stderr", chunk.toString()));

    return new Promise((resolve, reject) => {
      let settled = false;
      child.once("error", error => {
        processes.delete(requestId);
        if (!settled) {
          settled = true;
          reject(new Error("Could not start terminal command: " + error.message));
        }
      });
      child.once("close", (code, signal) => {
        processes.delete(requestId);
        if (settled) return;
        settled = true;
        resolve({ requestId, exitCode: typeof code === "number" ? code : 1, signal: signal || null, cwd: directory });
      });
    });
  }

  async function cancel(requestId) {
    const child = processes.get(requestId);
    if (!child) return false;
    if (platform === "win32" && child.pid) {
      const killer = spawnProcess("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      await new Promise(resolve => { killer.once("error", resolve); killer.once("close", resolve); });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch {
        try { child.kill("SIGTERM"); } catch {}
      }
    }
    return true;
  }

  async function stopAll() {
    await Promise.all([...processes.keys()].map(id => cancel(id)));
  }

  return Object.freeze({ run, cancel, stopAll, resolveCwd, activeCount: () => processes.size });
}

module.exports = { createTerminalRunner, MAX_COMMAND_LENGTH, MAX_CONCURRENT_COMMANDS };
