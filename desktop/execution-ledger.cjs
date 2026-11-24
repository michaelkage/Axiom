"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const CURRENT_SCHEMA = 1;
const MAX_OBJECTIVES = 250;
const MAX_EVENTS_PER_OBJECTIVE = 20_000;
const MAX_EVENT_BYTES = 64 * 1024;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const writeQueues = new Map();

function isRecord(value) { return !!value && typeof value === "object" && !Array.isArray(value); }
function boundedString(value, name, max) {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(name + " must be a non-empty string no longer than " + max + " characters.");
  return value.trim();
}
function validateObjective(objective) {
  if (!isRecord(objective) || typeof objective.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(objective.id) ||
      !Number.isSafeInteger(objective.revision) || objective.revision < 1 || !Array.isArray(objective.tasks) ||
      !Array.isArray(objective.events) || !isRecord(objective.budget) ||
      !["active", "paused", "blocked", "completed", "failed", "cancelled"].includes(objective.status)) {
    throw new TypeError("Objective does not match the execution-ledger schema.");
  }
  if (objective.tasks.length > 50 || objective.events.length > MAX_EVENTS_PER_OBJECTIVE) throw new RangeError("Objective exceeds execution-ledger limits.");
  return objective;
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function createExecutionLedger(userDataPath, workspaceRoot) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const workspaceKey = crypto.createHash("sha256").update(resolvedRoot).digest("hex");
  const directory = path.join(userDataPath, "execution-ledger");
  const file = path.join(directory, workspaceKey + ".json");
  function serialize(operation) {
    const queue = writeQueues.get(file) ?? Promise.resolve();
    const result = queue.then(operation);
    writeQueues.set(file, result.catch(() => undefined));
    return result;
  }
  async function readDisk() {
    let raw;
    try { raw = await fs.readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { schemaVersion: CURRENT_SCHEMA, workspaceRoot: resolvedRoot, revision: 0, objectives: {} }; throw error; }
    let data;
    try { data = JSON.parse(raw); }
    catch { throw new Error("Execution ledger is corrupt JSON; refusing to overwrite it."); }
    if (!isRecord(data) || data.schemaVersion !== CURRENT_SCHEMA || data.workspaceRoot !== resolvedRoot ||
        !Number.isSafeInteger(data.revision) || data.revision < 0 || !isRecord(data.objectives) ||
        Object.keys(data.objectives).length > MAX_OBJECTIVES) {
      throw new Error("Execution ledger has an unsupported schema or workspace identity; refusing to overwrite it.");
    }
    for (const [id, objective] of Object.entries(data.objectives)) {
      validateObjective(objective);
      if (objective.id !== id) throw new Error("Execution ledger objective key mismatch; refusing to overwrite it.");
    }
    return data;
  }
  async function writeDisk(data) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    try {
      await fs.writeFile(temporary, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, file);
    } finally { try { await fs.unlink(temporary); } catch {} }
  }
  async function list() {
    const data = await readDisk();
    return Object.values(data.objectives).map(clone).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async function get(id) {
    const data = await readDisk();
    return data.objectives[id] ? clone(data.objectives[id]) : null;
  }
  async function create(objective) {
    return serialize(async () => {
      validateObjective(objective);
      const data = await readDisk();
      if (data.objectives[objective.id]) throw new Error("Objective already exists: " + objective.id);
      if (Object.keys(data.objectives).length >= MAX_OBJECTIVES) throw new Error("Execution ledger objective limit reached.");
      const saved = clone(objective);
      saved.events = saved.events.slice(-MAX_EVENTS_PER_OBJECTIVE);
      data.objectives[saved.id] = saved;
      data.revision++;
      await writeDisk(data);
      return { revision: data.revision, objective: clone(saved) };
    });
  }
  async function commit(id, expectedObjectiveRevision, nextObjective, event) {
    return serialize(async () => {
      boundedString(id, "Objective ID", 128);
      if (!Number.isSafeInteger(expectedObjectiveRevision) || expectedObjectiveRevision < 1) throw new TypeError("Expected objective revision must be a positive integer.");
      validateObjective(nextObjective);
      if (nextObjective.id !== id) throw new Error("Objective ID cannot change during a ledger commit.");
      const data = await readDisk();
      const previous = data.objectives[id];
      if (!previous) throw new Error("Unknown objective: " + id);
      if (event !== undefined) {
        if (!isRecord(event) || typeof event.id !== "string" || typeof event.type !== "string") throw new TypeError("Ledger event requires a stable ID and type.");
        const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
        if (bytes > MAX_EVENT_BYTES) throw new RangeError("Ledger event exceeds the size limit.");
        if (previous.events.some(item => item.id === event.id)) return { revision: data.revision, objective: clone(previous), duplicate: true };
        if (nextObjective.events.at(-1)?.id !== event.id) throw new Error("Committed event must be present at the end of the objective event stream.");
      }
      if (previous.revision !== expectedObjectiveRevision) {
        const error = new Error("Objective revision conflict; reload before applying this transition.");
        error.code = "REVISION_CONFLICT";
        error.currentRevision = previous.revision;
        throw error;
      }
      if (TERMINAL.has(previous.status) && nextObjective.status !== previous.status) throw new Error("Terminal objectives are immutable.");
      if (nextObjective.revision !== expectedObjectiveRevision + 1) throw new Error("Next objective revision must increment exactly once.");
      data.objectives[id] = clone(nextObjective);
      data.objectives[id].events = data.objectives[id].events.slice(-MAX_EVENTS_PER_OBJECTIVE);
      data.revision++;
      await writeDisk(data);
      return { revision: data.revision, objective: clone(data.objectives[id]), duplicate: false };
    });
  }
  async function remove(id, expectedObjectiveRevision) {
    return serialize(async () => {
      const data = await readDisk();
      const previous = data.objectives[id];
      if (!previous) return false;
      if (previous.revision !== expectedObjectiveRevision) throw new Error("Objective revision conflict; reload before removal.");
      if (!TERMINAL.has(previous.status)) throw new Error("Only terminal objectives can be removed from the active ledger.");
      delete data.objectives[id];
      data.revision++;
      await writeDisk(data);
      return true;
    });
  }
  return Object.freeze({ list, get, create, commit, remove });
}

module.exports = { createExecutionLedger, CURRENT_SCHEMA, MAX_OBJECTIVES, MAX_EVENTS_PER_OBJECTIVE, MAX_EVENT_BYTES };
