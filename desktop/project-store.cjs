"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const MAX_CONTEXT_LENGTH = 50000;
const MAX_EVENTS = 500;

function projectKey(workspaceRoot) {
  return crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex");
}

function createProjectStore(userDataPath, workspaceRoot) {
  if (typeof workspaceRoot !== "string" || !path.isAbsolute(workspaceRoot)) {
    throw new TypeError("A project workspace must be an absolute path.");
  }
  const directory = path.join(userDataPath, "projects");
  const filePath = path.join(directory, projectKey(workspaceRoot) + ".json");

  async function read() {
    try {
      const parsed = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
      return {
        schemaVersion: 1,
        workspaceRoot: path.resolve(workspaceRoot),
        context: typeof parsed.context === "string" ? parsed.context.slice(0, MAX_CONTEXT_LENGTH) : "",
        changes: Array.isArray(parsed.changes) ? parsed.changes.slice(-MAX_EVENTS).filter(isValidChange) : [],
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
      };
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) {
        return { schemaVersion: 1, workspaceRoot: path.resolve(workspaceRoot), context: "", changes: [], updatedAt: null };
      }
      throw error;
    }
  }

  async function write(state) {
    await fs.promises.mkdir(directory, { recursive: true });
    const temporary = filePath + "." + process.pid + ".tmp";
    const serialized = JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2);
    await fs.promises.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
    await fs.promises.rename(temporary, filePath);
    return read();
  }

  // Serialize read-modify-write operations so concurrent worker lifecycle events
  // cannot overwrite one another with snapshots read before a neighboring write.
  let writeQueue = Promise.resolve();
  function serializeWrite(operation) {
    const result = writeQueue.then(operation);
    writeQueue = result.catch(() => undefined);
    return result;
  }

  async function saveContext(context) {
    if (typeof context !== "string") throw new TypeError("Project context must be text.");
    if (context.length > MAX_CONTEXT_LENGTH) throw new RangeError("Project context is limited to 50,000 characters.");
    return serializeWrite(async () => {
      const state = await read();
      state.context = context;
      return write(state);
    });
  }

  async function addChange(change) {
    if (!isValidChange(change)) throw new TypeError("Change event requires a title, summary, and valid status.");
    return serializeWrite(async () => {
      const state = await read();
      const event = {
      id: typeof change.id === "string" && change.id.length < 128 ? change.id : crypto.randomUUID(),
      title: change.title.trim().slice(0, 160),
      summary: change.summary.trim().slice(0, 2000),
      status: change.status,
      createdAt: typeof change.createdAt === "string" ? change.createdAt : new Date().toISOString(),
      checks: Array.isArray(change.checks) ? change.checks.slice(0, 30).map(check => ({
        name: String(check.name || "Check").slice(0, 120),
        state: ["passed", "failed", "skipped", "running"].includes(check.state) ? check.state : "skipped",
        details: String(check.details || "").slice(0, 2000)
      })) : [],
      files: Array.isArray(change.files) ? change.files.filter(file => typeof file === "string").slice(0, 200).map(file => file.slice(0, 500)) : []
      };
      const existingIndex = state.changes.findIndex(existing => existing.id === event.id);
      if (existingIndex >= 0) state.changes[existingIndex] = event;
      else state.changes.push(event);
      state.changes = state.changes.slice(-MAX_EVENTS);
      return write(state);
    });
  }

  return { read, saveContext, addChange };
}

function isValidChange(change) {
  return !!change &&
    typeof change.title === "string" && change.title.trim().length > 0 &&
    typeof change.summary === "string" && change.summary.trim().length > 0 &&
    ["planned", "working", "review", "verified", "failed", "reverted"].includes(change.status);
}

module.exports = { createProjectStore, isValidChange, MAX_CONTEXT_LENGTH, MAX_EVENTS };
