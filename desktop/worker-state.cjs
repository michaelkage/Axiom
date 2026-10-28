"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const MAX_TASKS = 500;
function createWorkerStateStore(userDataPath, workspaceRoot) {
  const key = crypto.createHash("sha256").update(path.resolve(workspaceRoot)).digest("hex");
  const dir = path.join(userDataPath, "worker-state"), file = path.join(dir, key + ".json");
  let queue = Promise.resolve();
  async function list() {
    try { const data = JSON.parse(await fs.readFile(file, "utf8")); return Array.isArray(data.tasks) ? data.tasks.filter(isValidTask).slice(-MAX_TASKS) : []; }
    catch (error) { if (error.code === "ENOENT" || error instanceof SyntaxError) return []; throw error; }
  }
  async function write(tasks) {
    await fs.mkdir(dir, { recursive: true });
    const temp = file + "." + process.pid + "." + crypto.randomUUID() + ".tmp";
    try { await fs.writeFile(temp, JSON.stringify({ schemaVersion: 1, workspaceRoot: path.resolve(workspaceRoot), updatedAt: new Date().toISOString(), tasks: tasks.slice(-MAX_TASKS) }, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" }); await fs.rename(temp, file); }
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
      // Retry attempts share a stable task ID. Reject delayed events from an older
      // attempt, but allow a newer attempt's running event to reopen a terminal task.
      if (index >= 0 && incomingAttempt < previousAttempt) return previous;
      // A retry only becomes active when its running event arrives. Do not let an
      // early terminal/queued event advance the generation and block that transition.
      if (index >= 0 && previousIsTerminal && incomingAttempt > previousAttempt && task.status !== "running") return previous;
      const startsNewAttempt = previousIsTerminal && incomingAttempt > previousAttempt && task.status === "running";
      const next = startsNewAttempt ? {
        ...task,
        attempt: incomingAttempt,
        logs: task.logs ?? [],
        error: task.error,
        result: task.result,
        finishedAt: task.finishedAt,
        updatedAt: new Date().toISOString()
      } : {
        ...previous,
        ...task,
        attempt: Math.max(previousAttempt, incomingAttempt),
        ...(previousIsTerminal ? {
          status: previous.status,
          error: previous.error,
          result: previous.result,
          finishedAt: previous.finishedAt,
          logs: task.status === previous.status && incomingAttempt === previousAttempt ? (task.logs ?? previous.logs) : (previous.logs ?? task.logs)
        } : {}),
        updatedAt: new Date().toISOString()
      };
      if (index >= 0) tasks[index] = next; else tasks.push(next);
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
function isValidTask(task) { return !!task && typeof task.taskId === "string" && task.taskId.length > 0 && task.taskId.length <= 128 && typeof task.title === "string" && task.title.length > 0 && (task.attempt == null || (Number.isInteger(task.attempt) && task.attempt > 0)) && ["queued","running","succeeded","failed","blocked","cancelled","timed_out"].includes(task.status); }
module.exports = { createWorkerStateStore, isValidTask, MAX_TASKS };
