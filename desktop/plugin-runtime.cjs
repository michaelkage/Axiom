"use strict";

const { spawn } = require("node:child_process");
const path = require("node:path");
const crypto = require("node:crypto");

const ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CAPABILITIES = new Set(["project.read", "project.write", "network.request", "shell.execute", "mcp.invoke", "artifact.write"]);
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
  const execute = options.spawn || spawn;
  const authorize = options.authorize;
  if (!options.pluginRoot || typeof authorize !== "function") throw new TypeError("Plugin runtime requires a plugin root and capability authorizer.");
  async function run(manifestInput, request = {}) {
    const manifest = validatePluginManifest(manifestInput);
    const entry = path.resolve(pluginRoot, manifest.id, manifest.entry);
    if (!entry.startsWith(path.resolve(pluginRoot, manifest.id) + path.sep)) throw new Error("Plugin entry escaped its installation directory.");
    const granted = [];
    for (const capability of manifest.capabilities) {
      if (await authorize({ pluginId: manifest.id, capability, request }) !== true) throw new Error("Plugin capability denied: " + capability);
      granted.push(capability);
    }
    const args = Array.isArray(request.args) ? request.args : [];
    if (args.length > MAX_ARGS || args.some(value => typeof value !== "string" || value.length > 4096 || value.includes("\0"))) throw new TypeError("Plugin arguments are invalid.");
    const runId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const child = execute(process.execPath, ["--disable-proto=throw", "--max-old-space-size=" + manifest.resources.memoryMb, entry, "--axiom-plugin-run=" + runId], {
        cwd: path.dirname(entry), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        env: { PATH: process.env.PATH || "", NODE_ENV: "production", AXIOM_PLUGIN_ID: manifest.id, AXIOM_PLUGIN_CAPABILITIES: granted.join(",") }
      });
      let stdout = "", stderr = "", settled = false;
      const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new Error("Plugin execution timed out.")); }, manifest.resources.timeoutMs);
      child.stdout?.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-256 * 1024); });
      child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-64 * 1024); });
      child.once("error", error => finish(error));
      child.once("close", (code, signal) => code === 0 ? finish(null, { runId, pluginId: manifest.id, exitCode: 0, stdout, stderr }) : finish(new Error("Plugin failed (code=" + code + ", signal=" + (signal || "none") + "): " + stderr.slice(-2000))));
      child.stdin?.end(JSON.stringify({ protocol: 1, runId, args }));
    });
  }
  return Object.freeze({ run });
}
module.exports = { createPluginRuntime, validatePluginManifest, CAPABILITIES, MAX_MANIFEST_BYTES };
