"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_TASKS = 500;
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
    return data.tasks.slice(-MAX_TASKS);
  }
  async function write(tasks) {
    await fs.mkdir(dir, { recursive: true });
    const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    try { await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, workspaceRoot: resolvedRoot, updatedAt: new Date().toISOString(), tasks: tasks.slice(-MAX_TASKS) }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" }); await fs.rename(temp, file); }
    finally { try { await fs.unlink(temp); } catch {} }
  }
  function serialize(operation) { const result = queue.then(operation); queue = result.catch(() => undefined); return result; }
  async function record(task) {
    if (!isValidTask(task)) throw new TypeError("Worker task record requires a stable taskId, title, and valid lifecycle status.");
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
      await write(tasks); return next;
    });
  }
  async function recoverInterrupted() {
    return serialize(async () => {
      const tasks = await list(); let changed = false; const now = Date.now();
      for (const task of tasks) {
        if (task.status === "running") { task.status = "failed"; task.error = "Axiom restarted before this worker reached a terminal state. Inspect the saved session/worktree before retrying."; task.finishedAt = now; task.updatedAt = new Date(now).toISOString(); changed = true; }
        else if (task.status === "queued") { task.status = "cancelled"; task.error = "Axiom restarted before this queued task began."; task.finishedAt = now; task.updatedAt = new Date(now).toISOString(); changed = true; }
      }
      if (changed) await write(tasks); return tasks;
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
module.exports = { createWorkerStateStore, isValidTask, MAX_TASKS };
