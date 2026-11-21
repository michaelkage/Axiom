"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_RECORDS = 100;
const MAX_PER_PROJECT = 20;

function createDeploymentHistoryStore(userDataPath, options = {}) {
  if (typeof userDataPath !== "string" || !userDataPath.trim()) throw new TypeError("Deployment history requires an application data directory.");
  const root = path.resolve(userDataPath);
  const file = path.join(root, "deployment-history.json");
  const fileSystem = options.fs || fs;
  async function read() {
    try {
      const parsed = JSON.parse(await fileSystem.readFile(file, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("Deployment history has an invalid format.");
      return parsed.filter(item => item && typeof item.id === "string" && typeof item.projectRoot === "string"
        && typeof item.previewUrl === "string" && ["vercel", "netlify", "cloudflare-pages"].includes(item.provider));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }
  return Object.freeze({
    async list(projectRoot) {
      const key = path.resolve(String(projectRoot || ""));
      if (!projectRoot) return [];
      return (await read()).filter(item => path.resolve(item.projectRoot) === key)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, MAX_PER_PROJECT);
    },
    async append(projectRoot, deployment) {
      if (typeof projectRoot !== "string" || !projectRoot.trim()) throw new TypeError("Project root is required.");
      if (!deployment || !["vercel", "netlify", "cloudflare-pages"].includes(deployment.provider)
        || typeof deployment.previewUrl !== "string" || !/^https:\/\//i.test(deployment.previewUrl)) {
        throw new TypeError("A verified HTTPS deployment result is required.");
      }
      const records = await read();
      const projectKey = path.resolve(projectRoot);
      const lastCreatedAt = records.filter(item => path.resolve(item.projectRoot) === projectKey)
        .reduce((latest, item) => Math.max(latest, Date.parse(item.createdAt) || 0), 0);
      const record = {
        id: crypto.randomUUID(),
        projectRoot: projectKey,
        createdAt: new Date(Math.max(Date.now(), lastCreatedAt + 1)).toISOString(),
        provider: deployment.provider,
        previewUrl: deployment.previewUrl,
        status: deployment.status === "deployed" ? "deployed" : "deployed_unverified",
        verification: {
          verified: deployment.verification?.verified === true,
          status: Number.isInteger(deployment.verification?.status) ? deployment.verification.status : null,
        },
        durationMs: Number.isFinite(deployment.durationMs) ? Math.max(0, Math.round(deployment.durationMs)) : 0,
      };
      const projectRecords = records.filter(item => path.resolve(item.projectRoot) !== record.projectRoot);
      const retainedForProject = records.filter(item => path.resolve(item.projectRoot) === record.projectRoot)
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, MAX_PER_PROJECT - 1);
      const next = [...projectRecords, ...retainedForProject, record]
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
        .slice(-MAX_RECORDS);
      await fileSystem.mkdir(root, { recursive: true, mode: 0o700 });
      const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
      await fileSystem.writeFile(temporary, JSON.stringify(next), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fileSystem.rename(temporary, file);
      return record;
    },
  });
}

module.exports = { createDeploymentHistoryStore, MAX_RECORDS, MAX_PER_PROJECT };
