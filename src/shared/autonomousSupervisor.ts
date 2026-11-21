import type { AxiomSubTask, TaskExecutionRecord, TaskExecutionStatus } from "./axiomRuntime";

export type ObjectiveStatus = "active" | "paused" | "blocked" | "completed" | "failed" | "cancelled";
export type SupervisorEventType =
  | "objective.started" | "objective.paused" | "objective.resumed" | "objective.cancelled"
  | "task.outcome" | "task.replanned" | "budget.exhausted" | "objective.completed" | "objective.blocked" | "task.recovered";

export interface SupervisorBudget {
  maxAttempts: number;
  maxElapsedMs: number;
  maxWorkers: number;
  startedAt: number;
  attemptsUsed: number;
}
export interface SupervisorTask extends AxiomSubTask {
  status: TaskExecutionStatus;
  attempt: number;
  error?: string;
  summary?: string;
  updatedAt: number;
  sessionId?: string;
}
export interface SupervisorEvent {
  id: string;
  objectiveId: string;
  sequence: number;
  type: SupervisorEventType;
  at: number;
  taskId?: string;
  payload: Record<string, unknown>;
}
export interface AutonomousObjective {
  id: string;
  title: string;
  instruction: string;
  status: ObjectiveStatus;
  createdAt: number;
  updatedAt: number;
  budget: SupervisorBudget;
  tasks: SupervisorTask[];
  events: SupervisorEvent[];
  revision: number;
}
export interface SupervisorOptions {
  maxAttempts?: number;
  maxElapsedMs?: number;
  maxWorkers?: number;
  now?: () => number;
}
const MAX_TASKS = 50;
const MAX_EVENTS = 20_000;
const MAX_TEXT = 8_000;
const TERMINAL_TASKS = new Set<TaskExecutionStatus>(["succeeded", "failed", "blocked", "cancelled", "timed_out"]);
const TERMINAL_OBJECTIVES = new Set<ObjectiveStatus>(["completed", "failed", "cancelled"]);

function boundedText(value: unknown, field: string, max = MAX_TEXT): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new TypeError(field + " must be a non-empty string of at most " + max + " characters.");
  return value.trim();
}
function eventId(objectiveId: string, sequence: number): string { return objectiveId + ":" + sequence; }
function appendEvent(objective: AutonomousObjective, type: SupervisorEventType, payload: Record<string, unknown>, now: number, taskId?: string): void {
  const sequence = objective.events.length ? objective.events[objective.events.length - 1].sequence + 1 : 1;
  objective.events.push({ id: eventId(objective.id, sequence), objectiveId: objective.id, sequence, type, at: now, ...(taskId ? { taskId } : {}), payload });
  if (objective.events.length > MAX_EVENTS) objective.events.splice(0, objective.events.length - MAX_EVENTS);
}
function assertBudget(budget: SupervisorBudget, now: number): string | null {
  if (budget.attemptsUsed >= budget.maxAttempts) return "The objective exhausted its total worker-attempt budget.";
  if (now - budget.startedAt >= budget.maxElapsedMs) return "The objective exceeded its wall-clock budget.";
  return null;
}

/** Create the durable-domain representation used by the supervisor and execution ledger. */
export function createAutonomousObjective(input: {
  id: string; title: string; instruction: string; tasks: AxiomSubTask[];
}, options: SupervisorOptions = {}): AutonomousObjective {
  const now = options.now?.() ?? Date.now();
  const id = boundedText(input.id, "Objective ID", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id)) throw new TypeError("Objective ID contains unsupported characters.");
  if (!Array.isArray(input.tasks) || input.tasks.length < 1 || input.tasks.length > MAX_TASKS) throw new TypeError("An objective must contain between 1 and " + MAX_TASKS + " tasks.");
  const taskIds = new Set<string>();
  const tasks = input.tasks.map(task => {
    const taskId = boundedText(task.id, "Task ID", 128);
    if (taskIds.has(taskId)) throw new Error("Duplicate task ID: " + taskId);
    taskIds.add(taskId);
    return { ...task, status: "queued" as const, attempt: 0, updatedAt: now };
  });
  for (const task of tasks) for (const dependency of task.dependsOn) if (!taskIds.has(dependency)) throw new Error("Unknown dependency " + dependency + " in task " + task.id);
  const maxAttempts = options.maxAttempts ?? Math.max(tasks.length * 3, tasks.length);
  const maxElapsedMs = options.maxElapsedMs ?? 60 * 60 * 1000;
  const maxWorkers = options.maxWorkers ?? 3;
  for (const [name, value] of Object.entries({ maxAttempts, maxElapsedMs, maxWorkers })) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 1_000_000) throw new RangeError(name + " must be a positive bounded integer.");
  }
  const objective: AutonomousObjective = {
    id, title: boundedText(input.title, "Objective title", 240),
    instruction: boundedText(input.instruction, "Objective instruction"),
    status: "active", createdAt: now, updatedAt: now, revision: 1,
    budget: { maxAttempts, maxElapsedMs, maxWorkers, startedAt: now, attemptsUsed: 0 },
    tasks, events: [],
  };
  appendEvent(objective, "objective.started", { taskCount: tasks.length, budget: { maxAttempts, maxElapsedMs, maxWorkers } }, now);
  return objective;
}

/**
 * Apply a worker outcome exactly once. Older attempts are ignored; an outcome
 * from a future attempt is rejected. The reducer never turns a terminal task
 * back into a live state, and never declares completion without all tasks
 * having succeeded.
 */
export function applySupervisorTaskOutcome(
  current: AutonomousObjective,
  record: TaskExecutionRecord,
  options: { now?: () => number; eventId?: string } = {},
): AutonomousObjective {
  const objective = structuredClone(current);
  if (TERMINAL_OBJECTIVES.has(objective.status) || objective.status === "paused") return objective;
  const now = options.now?.() ?? Date.now();
  const task = objective.tasks.find(item => item.id === record.taskId);
  if (!task) throw new Error("Outcome references an unknown task: " + record.taskId);
  const incomingAttempt = Number.isInteger(record.attempt) && (record.attempt ?? 0) > 0 ? record.attempt! : task.attempt || 1;
  if (incomingAttempt < task.attempt) return objective;
  if (incomingAttempt > task.attempt + 1) throw new Error("Outcome attempt skipped a generation for task " + task.id);
  if (TERMINAL_TASKS.has(task.status) && incomingAttempt <= task.attempt) return objective;
  if (record.status === "running" && TERMINAL_TASKS.has(task.status) && incomingAttempt <= task.attempt) return objective;
  if (record.status === "running" && incomingAttempt > task.attempt) {
    const exhausted = assertBudget(objective.budget, now);
    if (exhausted) {
      objective.status = "blocked";
      objective.updatedAt = now;
      appendEvent(objective, "budget.exhausted", { reason: exhausted }, now, task.id);
      appendEvent(objective, "objective.blocked", { reason: exhausted }, now);
      objective.revision++;
      return objective;
    }
    objective.budget.attemptsUsed++;
  }
  task.status = record.status;
  task.attempt = Math.max(task.attempt, incomingAttempt);
  task.updatedAt = now;
  if (typeof record.error === "string") task.error = record.error.slice(0, 4_000);
  if (typeof record.summary === "string") task.summary = record.summary.slice(0, 4_000);
  appendEvent(objective, "task.outcome", {
    status: record.status, attempt: task.attempt,
    ...(task.error ? { error: task.error } : {}),
    ...(task.summary ? { summary: task.summary } : {}),
    ...(record.startedAt ? { startedAt: record.startedAt } : {}),
    ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
  }, now, task.id);
  objective.updatedAt = now;
  if (objective.tasks.every(item => item.status === "succeeded")) {
    objective.status = "completed";
    appendEvent(objective, "objective.completed", { completedTasks: objective.tasks.length }, now);
  } else if (objective.tasks.some(item => item.status === "failed" || item.status === "timed_out")) {
    objective.status = "blocked";
    appendEvent(objective, "objective.blocked", { reason: "One or more tasks require repair or replanning." }, now);
  }
  objective.revision++;
  return objective;
}

export function setObjectiveStatus(
  current: AutonomousObjective,
  action: "pause" | "resume" | "cancel",
  now = Date.now(),
): AutonomousObjective {
  const objective = structuredClone(current);
  if (TERMINAL_OBJECTIVES.has(objective.status)) throw new Error("A terminal objective cannot be changed.");
  if (action === "pause") {
    if (objective.status !== "active") throw new Error("Only an active objective can be paused.");
    objective.status = "paused";
    appendEvent(objective, "objective.paused", {}, now);
  } else if (action === "resume") {
    if (objective.status !== "paused" && objective.status !== "blocked") throw new Error("Only a paused or blocked objective can be resumed.");
    objective.status = "active";
    appendEvent(objective, "objective.resumed", {}, now);
  } else {
    objective.status = "cancelled";
    for (const task of objective.tasks) if (task.status === "queued" || task.status === "running") {
      task.status = "cancelled"; task.updatedAt = now;
    }
    appendEvent(objective, "objective.cancelled", {}, now);
  }
  objective.updatedAt = now;
  objective.revision++;
  return objective;
}

export function getSupervisorSnapshot(objective: AutonomousObjective, now = Date.now()) {
  const elapsedMs = Math.max(0, now - objective.budget.startedAt);
  const counts = Object.fromEntries(["queued", "running", "succeeded", "failed", "blocked", "cancelled", "timed_out"].map(status => [
    status, objective.tasks.filter(task => task.status === status).length,
  ])) as Record<TaskExecutionStatus, number>;
  return {
    id: objective.id, title: objective.title, status: objective.status, revision: objective.revision,
    taskCount: objective.tasks.length, counts, attemptsUsed: objective.budget.attemptsUsed,
    attemptsRemaining: Math.max(0, objective.budget.maxAttempts - objective.budget.attemptsUsed),
    elapsedMs, timeRemainingMs: Math.max(0, objective.budget.maxElapsedMs - elapsedMs),
    maxWorkers: objective.budget.maxWorkers,
    completionPercent: Math.round((counts.succeeded / objective.tasks.length) * 100),
    latestEvent: objective.events[objective.events.length - 1] ?? null,
  };
}

/**
 * Reconcile persisted running tasks after process restart. A task is returned
 * to queued only when its recorded session is no longer alive; live sessions
 * remain attached and are not duplicated. Recovery is idempotent.
 */
export function recoverAutonomousObjective(
  current: AutonomousObjective,
  options: { isSessionAlive?: (sessionId: string) => boolean; now?: () => number } = {},
): AutonomousObjective {
  const objective = structuredClone(current);
  if (TERMINAL_OBJECTIVES.has(objective.status) || objective.status === "paused") return objective;
  const now = options.now?.() ?? Date.now();
  let changed = false;
  for (const task of objective.tasks) {
    if (task.status !== "running") continue;
    if (task.sessionId && options.isSessionAlive?.(task.sessionId) === true) continue;
    const previousSessionId = task.sessionId;
    task.status = "queued";
    task.updatedAt = now;
    delete task.sessionId;
    task.error = "Worker session was not recoverable after restart; task was safely re-queued.";
    appendEvent(objective, "task.recovered", {
      previousAttempt: task.attempt,
      ...(previousSessionId ? { previousSessionId } : {}),
      action: "requeued",
    }, now, task.id);
    changed = true;
  }
  if (changed) {
    objective.updatedAt = now;
    objective.revision++;
  }
  return objective;
}
