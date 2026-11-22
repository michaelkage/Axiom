"use strict";

const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CAPABILITIES = new Set(["project.read", "project.write"]);
const MAX_MANIFEST_BYTES = 32 * 1024;
const MAX_ARGS = 64;

function validatePluginManifest(input) {
  const bytes = Buffer.byteLength(JSON.stringify(input ?? null), "utf8");
  if (bytes > MAX_MANIFEST_BYTES || !input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Plugin manifest is invalid or too large.");
  if (input.apiVersion !== 1 || typeof input.id !== "string" || !ID.test(input.id)) throw new TypeError("Plugin manifest identity or API version is invalid.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) throw new TypeError("Plugin name is invalid.");
  if (typeof input.entry !== "string" || path.isAbsolute(input.entry) || input.entry.split(/[\\/]/).some(part => !part || part === "." || part === "..")) throw new TypeError("Plugin entry must be a normalized relative path.");
  if (!Array.isArray(input.capabilities) || input.capabilities.length > CAPABILITIES.size || input.capabilities.some(capability => !CAPABILITIES.has(capability)) || new Set(input.capabilities).size !== input.capabilities.length) throw new TypeError("Plugin capabilities are invalid or unsupported.");
  const resources = input.resources ?? {};
  const timeoutMs = Number(resources.timeoutMs ?? 30000);
  const memoryMb = Number(resources.memoryMb ?? 128);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000 || !Number.isInteger(memoryMb) || memoryMb < 32 || memoryMb > 1024) throw new TypeError("Plugin resource limits are outside the supported bounds.");
  return Object.freeze({ apiVersion: 1, id: input.id, name: input.name.trim(), entry: input.entry, capabilities: Object.freeze([...input.capabilities].sort()), resources: Object.freeze({ timeoutMs, memoryMb }) });
}

function createPluginRuntime(options = {}) {
  const pluginRoot = path.resolve(options.pluginRoot || "");
  const executeSandbox = options.spawnSandbox;
  const authorize = options.authorize;
  if (!options.pluginRoot || typeof authorize !== "function" || typeof executeSandbox !== "function") throw new TypeError("Plugin runtime requires a plugin root, capability authorizer, and OS sandbox adapter.");
  async function run(manifestInput, request = {}) {
    const manifest = validatePluginManifest(manifestInput);
    const pluginDirectory = fs.realpathSync(path.resolve(pluginRoot, manifest.id));
    const candidateEntry = path.resolve(pluginDirectory, manifest.entry);
    if (!candidateEntry.startsWith(pluginDirectory + path.sep)) throw new Error("Plugin entry escaped its installation directory.");
    const entry = fs.realpathSync(candidateEntry);
    if (!entry.startsWith(pluginDirectory + path.sep) || !fs.statSync(entry).isFile()) throw new Error("Plugin entry escaped its installation directory or is not a file.");
    const authorized = await authorize({ pluginId: manifest.id, capabilities: [...manifest.capabilities], request });
    if (authorized !== true) throw new Error("Plugin execution or one or more requested capabilities were denied.");
    const granted = [...manifest.capabilities];
    const needsWorkspace = granted.some(capability => capability === "project.read" || capability === "project.write");
    if (needsWorkspace && (typeof request.workspaceRoot !== "string" || !path.isAbsolute(request.workspaceRoot))) throw new Error("A project capability requires an absolute workspace root.");
    const args = Array.isArray(request.args) ? request.args : [];
    if (args.length > MAX_ARGS || args.some(value => typeof value !== "string" || value.length > 4096 || value.includes("\0"))) throw new TypeError("Plugin arguments are invalid.");
    const runId = crypto.randomUUID();
    const result = await executeSandbox({
      executable: process.execPath,
      args: ["--disable-proto=throw", "--max-old-space-size=" + manifest.resources.memoryMb, entry],
      cwd: pluginDirectory,
      pluginRoot: pluginDirectory,
      workspaceRoot: needsWorkspace ? request.workspaceRoot : undefined,
      env: { NODE_ENV: "production", ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}), AXIOM_PLUGIN_ID: manifest.id, AXIOM_PLUGIN_CAPABILITIES: granted.join(",") },
      stdin: JSON.stringify({ protocol: 1, runId, args }),
      limits: { timeoutMs: manifest.resources.timeoutMs, memoryMb: manifest.resources.memoryMb, stdoutBytes: 256 * 1024, stderrBytes: 64 * 1024, network: granted.includes("network.request"), filesystem: granted.filter(value => value.startsWith("project.") || value === "artifact.write") },
      runId
    });
    if (!result || result.exitCode !== 0 || result.timedOut || result.outputLimitExceeded) throw new Error(result?.timedOut ? "Plugin execution exceeded its time limit." : result?.outputLimitExceeded ? "Plugin execution exceeded its output limit." : "Sandboxed plugin execution failed.");
    return { runId, pluginId: manifest.id, exitCode: 0, stdout: String(result.stdout || "").slice(-256 * 1024), stderr: String(result.stderr || "").slice(-64 * 1024) };
  }
  return Object.freeze({ run });
}
module.exports = { createPluginRuntime, validatePluginManifest, CAPABILITIES, MAX_MANIFEST_BYTES };
