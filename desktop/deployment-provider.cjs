"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { redactSecrets: redactDiagnostic } = require("./security-redaction.cjs");

const execFileAsync = promisify(execFile);
const PROVIDERS = new Set(["vercel", "netlify", "cloudflare-pages"]);
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
  "SYSTEMROOT", "WINDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"
];

function requiredText(value, label, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) {
    throw new TypeError(label + " must be a non-empty string no longer than " + max + " characters.");
  }
  return value.trim();
}

async function resolveBuildOutput(projectRoot, outputDirectory) {
  const root = await fs.realpath(path.resolve(requiredText(projectRoot, "Project root", 4096)));
  const requested = path.resolve(root, requiredText(outputDirectory, "Build output directory", 4096));
  const output = await fs.realpath(requested);
  if (output === root || !output.startsWith(root + path.sep)) {
    throw new Error("Deployment output must be a child directory of the selected project.");
  }
  const stat = await fs.stat(output);
  if (!stat.isDirectory()) throw new Error("Deployment output must be a directory.");
  const entries = await fs.readdir(output);
  if (!entries.length) throw new Error("Deployment output directory is empty; build the project before deploying.");
  return { root, output };
}

function deploymentCommand(provider, input) {
  if (provider === "vercel") return {
    executable: input.executables?.vercel || "vercel",
    args: ["deploy", input.output, "--yes"],
    credentialName: "VERCEL_TOKEN",
  };
  if (provider === "netlify") {
    const siteId = requiredText(input.siteId, "Netlify site ID", 128);
    return {
      executable: input.executables?.netlify || "netlify",
      args: ["deploy", "--dir", input.output, "--site", siteId, "--json"],
      credentialName: "NETLIFY_AUTH_TOKEN",
    };
  }
  const projectName = requiredText(input.projectName, "Cloudflare Pages project name", 128);
  const branch = requiredText(input.branch || "axiom-preview", "Preview branch", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..")) {
    throw new TypeError("Preview branch contains unsupported characters.");
  }
  return {
    executable: input.executables?.wrangler || "wrangler",
    args: ["pages", "deploy", input.output, "--project-name", projectName, "--branch", branch],
    credentialName: "CLOUDFLARE_API_TOKEN",
  };
}

function extractPreviewUrl(provider, stdout) {
  const text = String(stdout || "");
  if (provider === "netlify") {
    for (const line of text.split(/\r?\n/)) {
      try {
        const value = JSON.parse(line);
        const candidate = value.deploy_url || value.deployUrl || value.url;
        if (typeof candidate === "string" && /^https:\/\/[a-z0-9.-]+(?:\/[^\s]*)?$/i.test(candidate)) return candidate;
      } catch { /* CLI may include non-JSON progress lines. */ }
    }
  }
  const matches = text.match(/https:\/\/[a-z0-9.-]+\.(?:vercel\.app|netlify\.app|pages\.dev)(?:\/[^\s"'<>]*)?/gi) || [];
  return matches.find(value => provider === "vercel" ? value.includes(".vercel.app")
    : provider === "netlify" ? value.includes(".netlify.app") : value.includes(".pages.dev")) || null;
}

function createDeploymentManager(options = {}) {
  const getCredential = options.getCredential;
  const execute = options.execFile || execFileAsync;
  if (typeof getCredential !== "function") throw new TypeError("Deployment manager requires a secure credential provider.");
  return Object.freeze({
    async deployPreview(request) {
      if (!request || typeof request !== "object" || !PROVIDERS.has(request.provider)) {
        throw new TypeError("Choose a supported deployment provider.");
      }
      if (request.target && request.target !== "preview") {
        throw new Error("This deployment adapter only supports preview deployments. Production promotion requires a separate explicit approval flow.");
      }
      const { root, output } = await resolveBuildOutput(request.projectRoot, request.outputDirectory);
      const command = deploymentCommand(request.provider, { ...request, output });
      const credential = await getCredential(request.provider);
      if (typeof credential !== "string" || credential.length < 8) {
        throw new Error("Save a valid " + request.provider + " credential in Axiom settings before deploying.");
      }
      const env = {};
      for (const key of ENV_ALLOWLIST) if (typeof process.env[key] === "string") env[key] = process.env[key];
      env[command.credentialName] = credential;
      if (request.provider === "cloudflare-pages") {
        env.CLOUDFLARE_ACCOUNT_ID = requiredText(request.accountId, "Cloudflare account ID", 128);
      }
      const startedAt = Date.now();
      let result;
      try {
        result = await execute(command.executable, command.args, {
          cwd: root, env, timeout: Math.min(Math.max(Number(request.timeoutMs) || 300_000, 10_000), 900_000),
          maxBuffer: 4 * 1024 * 1024, windowsHide: true,
        });
      } catch (error) {
        const detail = redactDiagnostic(error).slice(-4000);
        throw new Error("Preview deployment failed: " + detail);
      }
      const previewUrl = extractPreviewUrl(request.provider, result.stdout);
      if (!previewUrl) {
        throw new Error("The provider command completed but did not return a verifiable preview URL. Output: " + redactDiagnostic(result.stdout || result.stderr || "").slice(-2000));
      }
      return {
        provider: request.provider,
        target: "preview",
        previewUrl,
        startedAt,
        finishedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        outputDirectory: path.relative(root, output).split(path.sep).join("/"),
        status: "deployed",
      };
    },
  });
}

module.exports = { createDeploymentManager, resolveBuildOutput, deploymentCommand, extractPreviewUrl, PROVIDERS };
