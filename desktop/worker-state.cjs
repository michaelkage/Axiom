"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_TASKS = 500;
const MAX_LOG_LINES = 200;
const MAX_LOG_LINE_LENGTH = 4000;
const MAX_LOG_TOTAL_LENGTH = 32000;
const MAX_TITLE_LENGTH = 500;
const MAX_DIAGNOSTIC_LENGTH = 4096;
const MAX_ERROR_LENGTH = 8192;
const MAX_RESULT_LENGTH = 16000;
const TASK_FIELDS = ["taskId", "title", "status", "attempt", "sessionId", "worktreePath", "workerType", "integrationId", "toolName", "error", "logs", "startedAt", "finishedAt", "updatedAt", "result"];
function normalizeTask(task) {
  // Persist only the documented task schema; unknown fields must not bypass bounds.
  const normalized = {};
  for (const field of TASK_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(task, field)) normalized[field] = task[field];
  }
  normalized.title = task.title.slice(0, MAX_TITLE_LENGTH);
  for (const field of ["sessionId", "worktreePath", "workerType", "integrationId", "toolName"]) {
    if (typeof normalized[field] === "string") normalized[field] = normalized[field].slice(0, MAX_DIAGNOSTIC_LENGTH);
  }
  if (typeof normalized.error === "string") normalized.error = normalized.error.slice(0, MAX_ERROR_LENGTH);
  if (normalized.result !== undefined) normalized.result = normalizeResult(normalized.result);
  if (Array.isArray(normalized.logs)) {
    const recent = normalized.logs.slice(-MAX_LOG_LINES).map(line => line.slice(0, MAX_LOG_LINE_LENGTH));
    const bounded = [];
    let total = 0;
    for (let index = recent.length - 1; index >= 0; index--) {
      const remaining = MAX_LOG_TOTAL_LENGTH - total;
      if (remaining <= 0) break;
      const line = recent[index].slice(-remaining);
      bounded.unshift(line);
      total += line.length;
    }
    normalized.logs = bounded;
  }
  return normalized;
}
function normalizeResult(result) {
  // A persisted truncation envelope is already normalized; do not truncate it recursively on read.
  if (result && typeof result === "object" && result.truncated === true && typeof result.preview === "string") {
    return { truncated: true, preview: result.preview.slice(0, MAX_RESULT_LENGTH) };
  }
  let serialized;
  try { serialized = JSON.stringify(result); }
  catch { return { unavailable: true, reason: "Worker result was not JSON-serializable." }; }
  if (serialized === undefined) return { unavailable: true, reason: "Worker result was not JSON-serializable." };
  if (serialized.length <= MAX_RESULT_LENGTH) return result;
  return { truncated: true, preview: serialized.slice(0, MAX_RESULT_LENGTH) };
}
function createWorkerStateStore(userDataPath, workspaceRoot) {
  const resolvedRoot = path.resolve(workspaceRoot);
  const key = crypto.createHash("sha256").update(resolvedRoot).digest("hex");
  const dir = path.join(userDataPath, "worker-state"), file = path.join(dir, key + ".json");
  let queue = Promise.resolve();
  async function list() {
    let data;
    try { data = JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) {
      if (error.code === "ENOENT") return [];
      if (error instanceof SyntaxError) throw new Error("Worker state file is invalid JSON; refusing to overwrite persisted task history.");
      throw error;
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || data.schemaVersion !== 1 ||
        data.workspaceRoot !== resolvedRoot || !Array.isArray(data.tasks) || !data.tasks.every(isValidTask) || new Set(data.tasks.map(task => task.taskId)).size !== data.tasks.length) {
      throw new Error("Worker state file has an invalid schema or task record; refusing to overwrite persisted task history.");
    }
    return data.tasks.slice(-MAX_TASKS).map(normalizeTask);
  }
  async function write(tasks) {
    await fs.mkdir(dir, { recursive: true });
    const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    const boundedTasks = tasks.map(normalizeTask).slice(-MAX_TASKS);
    try { await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, workspaceRoot: resolvedRoot, updatedAt: new Date().toISOString(), tasks: boundedTasks }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" }); await fs.rename(temp, file); }
    finally { try { await fs.unlink(temp); } catch {} }
  }
  function serialize(operation) { const result = queue.then(operation); queue = result.catch(() => undefined); return result; }
  async function record(task) {
    if (!isValidTask(task)) throw new TypeError("Worker task record requires a stable taskId, title, and valid lifecycle status.");
    task = normalizeTask(task);
    return serialize(async () => {
      const tasks = await list(), index = tasks.findIndex(item => item.taskId === task.taskId);
      const previous = index >= 0 ? tasks[index] : {};
      const terminalStatuses = new Set(["succeeded", "failed", "blocked", "cancelled", "timed_out"]);
      const previousIsTerminal = terminalStatuses.has(previous.status);
      const incomingAttempt = Number.isInteger(task.attempt) && task.attempt > 0 ? task.attempt : 1;
      const previousAttempt = Number.isInteger(previous.attempt) && previous.attempt > 0 ? previous.attempt : 1;
      if (index >= 0 && incomingAttempt < previousAttempt) return previous;
      if (index >= 0 && previousIsTerminal && incomingAttempt > previousAttempt && task.status !== "running") return previous;
      const startsNewAttempt = previousIsTerminal && incomingAttempt > previousAttempt && task.status === "running";
      const next = startsNewAttempt ? {
        ...task, attempt: incomingAttempt, logs: task.logs ?? [], error: task.error,
        result: task.result, finishedAt: task.finishedAt, updatedAt: new Date().toISOString()
      } : {
        ...previous, ...task, attempt: Math.max(previousAttempt, incomingAttempt),
        ...(previousIsTerminal ? {
          status: previous.status, error: previous.error, result: previous.result,
          finishedAt: previous.finishedAt,
          logs: task.status === previous.status && incomingAttempt === previousAttempt ? (task.logs ?? previous.logs) : (previous.logs ?? task.logs)
        } : {}),
        updatedAt: new Date().toISOString()
      };
      if (index >= 0) tasks.splice(index, 1);
      tasks.push(next);
      await write(tasks); return normalizeTask(next);
    });
  }
  async function recoverInterrupted() {
    return serialize(async () => {
      const tasks = await list(); let changed = false; const now = Date.now();
      for (const task of tasks) {
        if (task.status === "running") { task.status = "failed"; task.error = "Axiom restarted before this worker reached a terminal state. Inspect the saved session/worktree before retrying."; task.finishedAt = now; task.updatedAt = new Date(now).toISOString(); changed = true; }
        else if (task.status === "queued") { task.status = "cancelled"; task.error = "Axiom restarted before this queued task began."; task.finishedAt = now; task.updatedAt = new Date(now).toISOString(); changed = true; }
      }
      if (changed) await write(tasks); return tasks.map(normalizeTask);
    });
  }
  return { list, record, recoverInterrupted };
}
function isValidTask(task) {
  if (!task || typeof task !== "object" || Array.isArray(task)) return false;
  if (typeof task.taskId !== "string" || !task.taskId.trim() || task.taskId.length > 128) return false;
  if (typeof task.title !== "string" || !task.title.trim()) return false;
  if (task.attempt != null && (!Number.isInteger(task.attempt) || task.attempt <= 0)) return false;
  if (!["queued","running","succeeded","failed","blocked","cancelled","timed_out"].includes(task.status)) return false;
  for (const field of ["sessionId", "worktreePath", "workerType", "integrationId", "toolName", "error"]) {
    if (task[field] != null && typeof task[field] !== "string") return false;
  }
  if (task.logs != null && (!Array.isArray(task.logs) || !task.logs.every(line => typeof line === "string"))) return false;
  for (const field of ["startedAt", "finishedAt"]) {
    if (task[field] != null && (typeof task[field] !== "number" || !Number.isFinite(task[field]))) return false;
  }
  if (task.updatedAt != null && (typeof task.updatedAt !== "string" || Number.isNaN(Date.parse(task.updatedAt)))) return false;
  return true;
}
module.exports = { createWorkerStateStore, isValidTask, MAX_TASKS, MAX_LOG_LINES, MAX_LOG_LINE_LENGTH, MAX_LOG_TOTAL_LENGTH, MAX_TITLE_LENGTH, MAX_DIAGNOSTIC_LENGTH, MAX_ERROR_LENGTH, MAX_RESULT_LENGTH };
