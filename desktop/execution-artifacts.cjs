"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { redactSecrets } = require("./security-redaction.cjs");
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const KINDS = new Set(["log", "diagnostic", "patch", "build", "report", "screenshot", "trace", "deployment"]);
function safeId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._:-]{1,160}$/.test(value)) throw new TypeError("Invalid " + label + ".");
  return value;
}
function createExecutionArtifactStore(options = {}) {
  const root = path.resolve(options.root || "");
  if (!options.root) throw new TypeError("Artifact storage root is required.");
  async function initialize() { await fs.mkdir(root, { recursive: true, mode: 0o700 }); }
  async function put(input) {
    await initialize();
    const projectId = safeId(input?.projectId, "project ID");
    const taskId = input.taskId == null ? null : safeId(input.taskId, "task ID");
    if (!KINDS.has(input.kind) || typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new TypeError("Artifact kind or name is invalid.");
    const data = Buffer.isBuffer(input.data) ? input.data : typeof input.data === "string" ? Buffer.from(input.data, "utf8") : null;
    if (!data || data.length > MAX_ARTIFACT_BYTES) throw new TypeError("Artifact data must be bytes or text within the 16 MiB limit.");
    const metadata = input.metadata ?? {};
    const metadataText = JSON.stringify(metadata);
    if (Buffer.byteLength(metadataText, "utf8") > MAX_METADATA_BYTES) throw new TypeError("Artifact metadata exceeds the size limit.");
    const directory = path.join(root, projectId);
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const id = crypto.randomUUID();
    const file = path.join(directory, id + ".artifact");
    const temporary = file + ".tmp";
    await fs.writeFile(temporary, data, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
    const record = { id, projectId, taskId, kind: input.kind, name: input.name.trim(), size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), createdAt: new Date().toISOString(), metadata: JSON.parse(metadataText), fileName: id + ".artifact" };
    const indexFile = path.join(directory, "index.json");
    let records = [];
    try { records = JSON.parse(await fs.readFile(indexFile, "utf8")); if (!Array.isArray(records)) throw new Error(); } catch (error) { if (error.code !== "ENOENT") { await fs.rm(file,{force:true}); throw new Error("Artifact index is corrupt; refusing to overwrite it."); } }
    records.push(record);
    const indexTemp = indexFile + "." + crypto.randomUUID() + ".tmp";
    await fs.writeFile(indexTemp, JSON.stringify(records.slice(-10000)), { mode: 0o600 });
    await fs.rename(indexTemp, indexFile);
    return { ...record };
  }
  async function list(projectId, taskId) {
    const directory = path.join(root, safeId(projectId, "project ID"));
    let records;
    try { records = JSON.parse(await fs.readFile(path.join(directory, "index.json"), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return []; throw new Error("Artifact index could not be read safely."); }
    if (!Array.isArray(records)) throw new Error("Artifact index is invalid.");
    return records.filter(record => !taskId || record.taskId === taskId).map(record => ({ ...record }));
  }
  async function read(projectId, artifactId) {
    const directory = path.join(root, safeId(projectId, "project ID"));
    const id = safeId(artifactId, "artifact ID");
    const records = await list(projectId);
    const record = records.find(item => item.id === id);
    if (!record) throw new Error("Artifact not found in this project.");
    const data = await fs.readFile(path.join(directory, id + ".artifact"));
    if (data.length !== record.size || crypto.createHash("sha256").update(data).digest("hex") !== record.sha256) throw new Error("Artifact integrity verification failed.");
    return { record, data };
  }
  async function remove(projectId, artifactId) {
    const directory = path.join(root, safeId(projectId, "project ID"));
    const id = safeId(artifactId, "artifact ID");
    const records = await list(projectId);
    const next = records.filter(item => item.id !== id);
    if (next.length === records.length) return false;
    await fs.rm(path.join(directory, id + ".artifact"), { force: true });
    const temporary = path.join(directory, "index." + crypto.randomUUID() + ".tmp");
    await fs.writeFile(temporary, JSON.stringify(next), { mode: 0o600 });
    await fs.rename(temporary, path.join(directory, "index.json"));
    return true;
  }
  return Object.freeze({ put, list, read, remove });
}
module.exports = { createExecutionArtifactStore, MAX_ARTIFACT_BYTES, KINDS };
