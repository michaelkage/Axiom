"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1";
const INSTALL_GUIDE = "https://github.com/diegosouzapw/OmniRoute";

function normalizeBaseUrl(value) {
  if (typeof value !== "string" || value.length > 2048) throw new Error("Enter a valid OmniRoute/API base URL.");
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new Error("Enter a valid OmniRoute/API base URL."); }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("The API URL must use HTTP(S) and cannot contain credentials, query strings, or fragments.");
  }
  return parsed.toString().replace(/\/+$/, "");
}

function isLoopback(url) {
  const host = new URL(url).hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function createOmniRouteManager({ userDataPath, safeStorage, platform = process.platform, spawnProcess = spawn, fetchImpl = fetch }) {
  const configPath = path.join(userDataPath, "omniroute-settings.json");
  let ownedProcess = null;
  let installProcess = null;
  let runtimeLog = "";

  function readRaw() {
    try { return JSON.parse(fs.readFileSync(configPath, "utf8")); }
    catch { return {}; }
  }

  function readConfig() {
    const raw = readRaw();
    let apiKey = "";
    if (raw.apiKeyEncrypted && safeStorage?.isEncryptionAvailable?.()) {
      try { apiKey = safeStorage.decryptString(Buffer.from(raw.apiKeyEncrypted, "base64")); } catch {}
    }
    return {
      baseUrl: normalizeBaseUrl(raw.baseUrl || DEFAULT_BASE_URL),
      model: typeof raw.model === "string" && /^[a-zA-Z0-9._:/-]{1,160}$/.test(raw.model) ? raw.model : "auto",
      enabled: raw.enabled === true,
      autoStart: raw.autoStart === true,
      apiKey,
      installRequested: raw.installRequested === true
    };
  }

  function writeConfig(config) {
    fs.mkdirSync(userDataPath, { recursive: true });
    const raw = {
      baseUrl: config.baseUrl,
      model: config.model,
      enabled: config.enabled,
      autoStart: config.autoStart,
      installRequested: config.installRequested === true
    };
    if (config.apiKey) {
      if (!safeStorage?.isEncryptionAvailable?.()) throw new Error("This system does not provide secure credential storage. Leave the API key blank or configure it in OpenCode directly.");
      raw.apiKeyEncrypted = safeStorage.encryptString(config.apiKey).toString("base64");
    } else if (readRaw().apiKeyEncrypted) {
      raw.apiKeyEncrypted = readRaw().apiKeyEncrypted;
    }
    const temp = configPath + ".tmp";
    fs.writeFileSync(temp, JSON.stringify(raw, null, 2), { mode: 0o600 });
    fs.renameSync(temp, configPath);
  }

  function findCommand(command) {
    const lookup = spawnSync(platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8", windowsHide: true });
    if (lookup.status !== 0 || !lookup.stdout.trim()) return null;
    return lookup.stdout.split(/\r?\n/).map(line => line.trim()).find(Boolean) || null;
  }

  async function status() {
    const config = readConfig();
    let endpoint = { reachable: false, authenticated: false, models: [], message: "Not checked yet." };
    try {
      const response = await fetchImpl(config.baseUrl.replace(/\/+$/, "") + "/models", {
        headers: config.apiKey ? { Authorization: "Bearer " + config.apiKey } : {},
        signal: AbortSignal.timeout(2500)
      });
      if (response.ok) {
        const payload = await response.json().catch(() => ({}));
        endpoint = {
          reachable: true, authenticated: true,
          models: Array.isArray(payload.data) ? payload.data.filter(item => item && typeof item.id === "string").slice(0, 300).map(item => ({ id: item.id, name: typeof item.name === "string" ? item.name : item.id })) : [],
          message: "API reachable."
        };
      } else if (response.status === 401 || response.status === 403) {
        endpoint = { reachable: true, authenticated: false, models: [], message: "Router is running but requires a valid API key." };
      } else {
        endpoint = { reachable: true, authenticated: false, models: [], message: "Endpoint responded with HTTP " + response.status + "." };
      }
    } catch (error) {
      endpoint.message = error instanceof Error ? error.message : String(error);
    }
    return {
      config: { baseUrl: config.baseUrl, model: config.model, enabled: config.enabled, autoStart: config.autoStart, hasApiKey: !!config.apiKey },
      endpoint,
      installed: !!findCommand("omniroute"),
      ownedProcessRunning: !!ownedProcess && ownedProcess.exitCode === null,
      installing: !!installProcess,
      installGuide: INSTALL_GUIDE,
      log: runtimeLog.slice(-1500)
    };
  }

  async function save(input) {
    if (!input || typeof input !== "object") throw new Error("Invalid OmniRoute settings.");
    const previous = readConfig();
    const baseUrl = normalizeBaseUrl(input.baseUrl ?? previous.baseUrl);
    const model = typeof input.model === "string" && /^[a-zA-Z0-9._:/-]{1,160}$/.test(input.model.trim()) ? input.model.trim() : "auto";
    const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (apiKey.length > 4096) throw new Error("API key is too long.");
    const config = {
      baseUrl, model,
      enabled: input.enabled === true,
      autoStart: input.autoStart === true,
      apiKey,
      installRequested: previous.installRequested
    };
    if (config.autoStart && (!isLoopback(baseUrl) || new URL(baseUrl).port && new URL(baseUrl).port !== "20128")) {
      throw new Error("Automatic launch is only supported for the local OmniRoute service on port 20128. Custom URLs can still be attached.");
    }
    if (!config.enabled) config.autoStart = false;
    writeConfig(config);
    return { saved: true, requiresRestart: true, config: { baseUrl, model, enabled: config.enabled, autoStart: config.autoStart, hasApiKey: !!(apiKey || previous.apiKey) } };
  }

  async function install() {
    if (installProcess) throw new Error("OmniRoute installation is already running.");
    const command = platform === "win32" ? "npm.cmd" : "npm";
    const child = spawnProcess(command, ["install", "--global", "omniroute"], {
      windowsHide: true, shell: platform === "win32", stdio: ["ignore", "pipe", "pipe"]
    });
    installProcess = child;
    runtimeLog = "Installing OmniRoute with npm install --global omniroute…";
    let output = "";
    child.stdout?.on("data", chunk => { output = (output + chunk.toString()).slice(-5000); });
    child.stderr?.on("data", chunk => { output = (output + chunk.toString()).slice(-5000); });
    try {
      const result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve({ code }) : reject(new Error("npm install failed with exit code " + code + ". " + output)));
      });
      runtimeLog = "OmniRoute installation completed. " + output.slice(-1200);
      return { installed: true, result };
    } catch (error) {
      runtimeLog = "OmniRoute installation failed. " + output.slice(-1200);
      throw error;
    } finally {
      installProcess = null;
    }
  }

  async function start() {
    const config = readConfig();
    if (!isLoopback(config.baseUrl) || (new URL(config.baseUrl).port && new URL(config.baseUrl).port !== "20128")) {
      throw new Error("Axiom can only launch a local OmniRoute instance on port 20128. Use connection checking for other URLs.");
    }
    const existing = await status();
    if (existing.endpoint.reachable) return { started: false, alreadyRunning: true };
    if (ownedProcess && ownedProcess.exitCode === null) throw new Error("OmniRoute is already starting.");
    const executable = findCommand("omniroute");
    if (!executable) throw new Error("OmniRoute is not installed. Use Install OmniRoute first, or connect to an existing router URL.");
    const child = spawnProcess(executable, [], {
      cwd: userDataPath, windowsHide: true, shell: platform === "win32",
      stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32"
    });
    ownedProcess = child;
    const collect = chunk => { runtimeLog = (runtimeLog + chunk.toString()).slice(-5000); };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("exit", () => { if (ownedProcess === child) ownedProcess = null; });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error("OmniRoute exited while starting. " + runtimeLog.slice(-1200));
      await new Promise(resolve => setTimeout(resolve, 500));
      const current = await status();
      if (current.endpoint.reachable) return { started: true, alreadyRunning: false };
    }
    throw new Error("OmniRoute did not respond on port 20128 within 20 seconds. " + runtimeLog.slice(-1200));
  }

  async function stop() {
    const child = ownedProcess;
    if (!child || child.exitCode !== null) return { stopped: false, reason: "Axiom did not start this OmniRoute process." };
    ownedProcess = null;
    if (platform === "win32" && child.pid) {
      const killer = spawnProcess("taskkill.exe", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
      await new Promise(resolve => { killer.once("error", resolve); killer.once("close", resolve); });
    } else {
      try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch {} }
    }
    return { stopped: true };
  }

  function openCodeEnvironment() {
    const config = readConfig();
    if (!config.enabled) return {};
    const model = config.model || "auto";
    const provider = {
      npm: "@ai-sdk/openai-compatible",
      name: "OmniRoute",
      options: { baseURL: config.baseUrl, ...(config.apiKey ? { apiKey: config.apiKey } : {}) },
      models: { [model]: { name: model } }
    };
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { omniroute: provider }, model: "omniroute/" + model }) };
  }

  async function startIfConfigured() {
    const config = readConfig();
    if (config.enabled && config.autoStart) return start();
    return { started: false, skipped: true };
  }

  return Object.freeze({ status, save, install, start, stop, startIfConfigured, openCodeEnvironment, ownsProcess: () => !!ownedProcess && ownedProcess.exitCode === null, getConfig: () => {
    const c = readConfig();
    return { baseUrl: c.baseUrl, model: c.model, enabled: c.enabled, autoStart: c.autoStart, hasApiKey: !!c.apiKey };
  } });
}

module.exports = { createOmniRouteManager, DEFAULT_BASE_URL, normalizeBaseUrl, isLoopback };
