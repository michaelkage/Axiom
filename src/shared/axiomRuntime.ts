import { classifyRecovery } from "./recovery";
export interface AxiomRuntimeConfig {
  gatewayUrl: string;
  nativeOmniRoute: boolean;
  enableSubAgents: boolean;
  errorHealing: "off" | "notify" | "safe-retry";
  requestTimeoutMs: number;
  maxAutomaticRetries: number;
}
export const DEFAULT_AXIOM_RUNTIME: AxiomRuntimeConfig = {
  gatewayUrl: "http://127.0.0.1:20128/v1",
  nativeOmniRoute: true,
  enableSubAgents: true,
  errorHealing: "notify",
  requestTimeoutMs: 20_000,
  maxAutomaticRetries: 1,
};
export interface AxiomSubTask {
  id: string;
  title: string;
  scope: string;
  targetFiles: string[];
  dependsOn: string[];
  agentHint?: string;
  acceptanceCriteria?: string[];
}
export interface AxiomPluginContext {
  workspaceRoot: string;
  readFile(path: string): Promise<string>;
  runCheck(command: string): Promise<{ exitCode: number; output: string }>;
}
export interface AxiomPlugin {
  id: string;
  version: string;
  description: string;
  activate(context: AxiomPluginContext): Promise<void> | void;
  deactivate?(): Promise<void> | void;
}
export interface OmniRouteTelemetry {
  model?: string;
  combo?: string;
  inputTokens?: number;
  compressedInputTokens?: number;
  latencyMs?: number;
  fallbackUsed?: boolean;
}
export function compressionPercent(inputTokens: number, compressedInputTokens: number): number | null {
  if (!Number.isFinite(inputTokens) || !Number.isFinite(compressedInputTokens) || inputTokens <= 0 || compressedInputTokens < 0) return null;
  return Math.max(0, Math.min(100, (1 - compressedInputTokens / inputTokens) * 100));
}
export function createIndependentTasks(tasks: AxiomSubTask[]): AxiomSubTask[][] {
  const remaining = new Map<string, AxiomSubTask>();
  for (const task of tasks) {
    if (!task.id.trim() || remaining.has(task.id)) throw new Error(`Duplicate or empty task id: ${task.id}`);
    remaining.set(task.id, task);
  }
  const ids = new Set(remaining.keys());
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} in task ${task.id}`);
    }
  }
  const completed = new Set<string>();
  const batches: AxiomSubTask[][] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(task => task.dependsOn.every(id => completed.has(id)));
    if (!ready.length) throw new Error("Task graph contains a dependency cycle or an unknown dependency.");
    // Avoid concurrent writes to the same declared target file. Tasks that
    // overlap are deferred to a later batch even when their dependencies allow parallelism.
    const batch: AxiomSubTask[] = [];
    const claimedPaths = new Set<string>();
    for (const task of ready) {
      const paths = task.targetFiles.map(path => path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase());
      // Unknown target sets are exclusive: without a declared scope, do not
      // run this task alongside any other writer.
      if (task.targetFiles.length === 0) {
        if (batch.length > 0) continue;
        batch.push(task);
        break;
      }
      const overlaps = (left: string, right: string) => left === right || left.startsWith(right.endsWith("/") ? right : right + "/") || right.startsWith(left.endsWith("/") ? left : left + "/");
      if (batch.some(item => item.targetFiles.length === 0) || paths.some(path => [...claimedPaths].some(claimed => overlaps(path, claimed)))) continue;
      batch.push(task);
      for (const path of paths) claimedPaths.add(path);
    }
    if (!batch.length) throw new Error("Task graph could not be scheduled safely.");
    batches.push(batch);
    for (const task of batch) { remaining.delete(task.id); completed.add(task.id); }
  }
  return batches;
}

export type TaskExecutionStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out";
export interface TaskExecutionRecord {
  taskId: string; title: string; status: TaskExecutionStatus;
  startedAt?: number; finishedAt?: number; sessionId?: string; worktreePath?: string; agent?: string; summary?: string; error?: string; contextEstimatedTokensBefore?: number; contextEstimatedTokensAfter?: number; contextSavingsPercent?: number;
}
export interface CompletedTaskContext { task: AxiomSubTask; result: unknown; }
export interface TaskBatchExecutionOptions {
  /** Abort stops launching later batches; in-flight work receives the signal and may opt to stop. */
  signal?: AbortSignal;
  /** Per-task wall-clock limit. Timed-out runners may continue if they ignore the signal. */
  timeoutMs?: number;
}
export class TaskBatchExecutionError extends Error {
  constructor(
    message: string,
    public readonly successfulResults: Array<{ task: AxiomSubTask; result: unknown }>,
    public readonly failedTaskIds: string[],
    public readonly blockedTaskIds: string[],
  ) {
    super(message);
    this.name = "TaskBatchExecutionError";
  }
}
export async function executeTaskBatches<T>(
  tasks: AxiomSubTask[],
  runner: (task: AxiomSubTask, completed: ReadonlyArray<CompletedTaskContext>, signal?: AbortSignal) => Promise<T>,
  onOutcome?: (record: TaskExecutionRecord) => void,
  options: TaskBatchExecutionOptions = {},
): Promise<Array<{ task: AxiomSubTask; result: T }>> {
  const completed: Array<{ task: AxiomSubTask; result: T }> = [];
  const completedContext: CompletedTaskContext[] = [];
  const emit = (record: TaskExecutionRecord) => { try { onOutcome?.(record); } catch { /* observers must not break task execution */ } };
  const batches = createIndependentTasks(tasks);
  const outcomeById = new Map<string, TaskExecutionStatus>();
  for (const task of tasks) { outcomeById.set(task.id, "queued"); emit({ taskId: task.id, title: task.title, status: "queued" }); }

  const finishFailure = (failedIds: string[], reason: string, terminalStatus: "failed" | "cancelled" = "failed"): never => {
    const failedSet = new Set(failedIds);
    const blocked = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (outcomeById.get(task.id) !== "queued" || blocked.has(task.id)) continue;
        if (task.dependsOn.some(id => failedSet.has(id) || blocked.has(id))) {
          blocked.add(task.id);
          outcomeById.set(task.id, "blocked");
          emit({ taskId: task.id, title: task.title, status: "blocked", finishedAt: Date.now(), error: "Blocked by an unsuccessful dependency." });
          changed = true;
        }
      }
    }
    if (terminalStatus === "cancelled") {
      for (const task of tasks) {
        if (outcomeById.get(task.id) !== "queued") continue;
        outcomeById.set(task.id, "cancelled");
        emit({ taskId: task.id, title: task.title, status: "cancelled", finishedAt: Date.now(), error: reason });
      }
    }
    const failed = tasks.filter(task => outcomeById.get(task.id) === "failed" || outcomeById.get(task.id) === "timed_out").map(task => task.id);
    const blockedIds = tasks.filter(task => blocked.has(task.id)).map(task => task.id);
    throw new TaskBatchExecutionError(reason, completed.map(item => ({ task: item.task, result: item.result })), [...new Set([...failedIds, ...failed])], blockedIds);
  };

  for (const batch of batches) {
    if (options.signal?.aborted) finishFailure([], "Task execution cancelled before the next batch.", "cancelled");
    const settled = await Promise.allSettled(batch.map(async task => {
      const startedAt = Date.now();
      const controller = new AbortController();
      const abortFromParent = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", abortFromParent, { once: true });
      if (options.signal?.aborted) abortFromParent();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        outcomeById.set(task.id, "running");
        emit({ taskId: task.id, title: task.title, status: "running", startedAt });
        const runnerPromise = runner(task, [...completedContext], controller.signal);
        let removeCancellationListener = () => {};
        const cancellation = options.signal ? new Promise<never>((_, reject) => {
          const cancel = () => reject(new Error("Task execution cancelled."));
          if (options.signal!.aborted) cancel();
          else {
            options.signal!.addEventListener("abort", cancel, { once: true });
            removeCancellationListener = () => options.signal!.removeEventListener("abort", cancel);
          }
        }) : new Promise<never>(() => {});
        const timeoutPromise = options.timeoutMs && options.timeoutMs > 0 ? new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            controller.abort(new Error("Task timed out"));
            reject(new Error("Task timed out after " + options.timeoutMs + "ms"));
          }, options.timeoutMs);
        }) : new Promise<never>(() => {});
        let result: T;
        try { result = await Promise.race([runnerPromise, timeoutPromise, cancellation]); }
        finally { removeCancellationListener(); }
        outcomeById.set(task.id, "succeeded");
        const detail = result && typeof result === "object" ? result as Record<string, unknown> : {};
        emit({
          taskId: task.id, title: task.title, status: "succeeded", startedAt, finishedAt: Date.now(),
          ...(typeof detail.sessionId === "string" ? { sessionId: detail.sessionId } : {}),
          ...(typeof detail.worktreePath === "string" ? { worktreePath: detail.worktreePath } : {}),
          ...(typeof detail.agent === "string" ? { agent: detail.agent } : {}),
          ...(typeof detail.summary === "string" ? { summary: detail.summary } : {}),
          ...(typeof detail.contextEstimatedTokensBefore === "number" ? { contextEstimatedTokensBefore: detail.contextEstimatedTokensBefore } : {}),
          ...(typeof detail.contextEstimatedTokensAfter === "number" ? { contextEstimatedTokensAfter: detail.contextEstimatedTokensAfter } : {}),
          ...(typeof detail.contextSavingsPercent === "number" ? { contextSavingsPercent: detail.contextSavingsPercent } : {}),
        });
        return { task, result };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const timedOut = /timed out after \d+ms/i.test(errorMessage);
        const cancelled = !timedOut && (options.signal?.aborted || /cancelled/i.test(errorMessage));
        const status: TaskExecutionStatus = timedOut ? "timed_out" : cancelled ? "cancelled" : "failed";
        outcomeById.set(task.id, status);
        const detail = error && typeof error === "object" ? error as Record<string, unknown> : {};
        emit({
          taskId: task.id, title: task.title, status, startedAt, finishedAt: Date.now(),
          error: errorMessage,
          ...(typeof detail.sessionId === "string" ? { sessionId: detail.sessionId } : {}),
          ...(typeof detail.worktreePath === "string" ? { worktreePath: detail.worktreePath } : {}),
          ...(typeof detail.agent === "string" ? { agent: detail.agent } : {}),
        });
        throw error;
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        options.signal?.removeEventListener("abort", abortFromParent);
      }
    }));
    for (const entry of settled) if (entry.status === "fulfilled") {
      completed.push(entry.value);
      completedContext.push({ task: entry.value.task, result: entry.value.result });
    }
    const failures = settled.flatMap((entry, index) => entry.status === "rejected" && (outcomeById.get(batch[index].id) === "failed" || outcomeById.get(batch[index].id) === "timed_out") ? [batch[index].id] : []);
    const cancelled = settled.some((entry, index) => entry.status === "rejected" && outcomeById.get(batch[index].id) === "cancelled");
    if (failures.length || cancelled) {
      const details = settled.flatMap(entry => entry.status === "rejected" ? [entry.reason instanceof Error ? entry.reason.message : String(entry.reason)] : []);
      finishFailure(failures, (cancelled ? "Parallel task batch was cancelled." : "Parallel task batch failed; successful task results were preserved.") + " " + details.join("; "), cancelled ? "cancelled" : "failed");
    }
  }
  return completed;
}

export interface OmniRouteModel { id: string; name: string; }
export interface OmniRouteDiscovery {
  reachable: boolean;
  models: OmniRouteModel[];
  checkedAt: number;
  warning?: string;
}
/** GET /models is both a gateway reachability probe and the source of its advertised model inventory. */
export async function discoverOmniRouteModels(
  config: AxiomRuntimeConfig = DEFAULT_AXIOM_RUNTIME,
  fetcher: typeof fetch = fetch,
): Promise<OmniRouteDiscovery> {
  const checkedAt = Date.now();
  const base = config.gatewayUrl.replace(/\/+$/, "");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetcher(base + "/models", { method: "GET", headers: { Accept: "application/json" }, signal: controller.signal });
    if (!response.ok) return { reachable: true, models: [], checkedAt, warning: "OmniRoute is reachable but model discovery returned HTTP " + response.status + "." };
    const payload = await response.json() as { data?: unknown };
    if (!Array.isArray(payload?.data)) return { reachable: true, models: [], checkedAt, warning: "OmniRoute responded, but its model inventory was not in the expected OpenAI-compatible format." };
    const models = payload.data.flatMap((item): OmniRouteModel[] => {
      if (!item || typeof item !== "object" || typeof (item as Record<string, unknown>).id !== "string") return [];
      const model = item as Record<string, unknown>;
      return [{ id: model.id as string, name: typeof model.name === "string" ? model.name : model.id as string }];
    });
    return { reachable: true, models, checkedAt, ...(models.length ? {} : { warning: "OmniRoute is reachable but advertises no models." }) };
  } catch (error) {
    const advice = classifyRecovery(error);
    return { reachable: false, models: [], checkedAt, warning: advice.explanation };
  } finally {
    clearTimeout(timeout);
  }
}
/** Choose a fallback only when explicitly configured; report the route change to the caller. */
export function resolveOmniRouteModel(
  requestedModel: string,
  availableModels: OmniRouteModel[],
  fallbackModel?: string,
): { model: string | null; fallbackUsed: boolean; explanation?: string } {
  const available = new Set(availableModels.map(model => model.id));
  if (available.has(requestedModel)) return { model: requestedModel, fallbackUsed: false };
  if (fallbackModel && available.has(fallbackModel)) {
    return { model: fallbackModel, fallbackUsed: true, explanation: "Requested model " + requestedModel + " was unavailable; explicitly configured fallback " + fallbackModel + " was selected." };
  }
  return { model: null, fallbackUsed: false, explanation: "Requested model " + requestedModel + " is not in the discovered inventory; no usable fallback was configured." };
}

export async function planSubTasksWithOmniRoute(
  prompt: string,
  model: string,
  config: AxiomRuntimeConfig = DEFAULT_AXIOM_RUNTIME,
  fetcher: typeof fetch = fetch,
): Promise<AxiomSubTask[]> {
  const response = await requestOmniRoute<{
    choices?: Array<{ message?: { content?: string } }>;
  }>("chat/completions", {
    model,
    temperature: 0.1,
    messages: [
      { role: "system", content: "Split the user request into small independent coding tasks. Return only a JSON object with a tasks array. Each task must have id, title, scope, targetFiles (array of workspace-relative file paths), dependsOn (array of task IDs), acceptanceCriteria (array of observable, testable strings), and optional agentHint. Use disjoint targetFiles for tasks that can run in parallel. Never invent absolute paths. If a task's files are uncertain, use a narrow, explicit likely path and keep the task small." },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  }, config, fetcher);
  const content = response.choices?.[0]?.message?.content;
  if (!content) throw new Error("OmniRoute planner returned no message content.");
  let decoded: unknown;
  try { decoded = JSON.parse(content); }
  catch { throw new Error("OmniRoute planner did not return valid JSON."); }
  const taskList = decoded && typeof decoded === "object" ? (decoded as Record<string, unknown>).tasks : undefined;
  return parseSubTasks(taskList);
}
export function parseSubTasks(value: unknown): AxiomSubTask[] {
  if (!Array.isArray(value)) throw new Error("Planner response must be an array of tasks.");
  const tasks = value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Task ${index + 1} must be an object.`);
    const task = item as Record<string, unknown>;
    if (typeof task.id !== "string" || typeof task.title !== "string" || typeof task.scope !== "string" || !Array.isArray(task.targetFiles) || !Array.isArray(task.dependsOn))
      throw new Error(`Task ${index + 1} is missing required fields.`);
    if (![...task.targetFiles, ...task.dependsOn].every(value => typeof value === "string")) throw new Error(`Task ${index + 1} contains invalid file or dependency references.`);
    if (!task.id.trim() || !task.title.trim() || !task.scope.trim()) throw new Error(`Task ${index + 1} needs non-empty id, title, and scope.`);
    if (!Array.isArray(task.acceptanceCriteria) || task.acceptanceCriteria.length === 0 || !task.acceptanceCriteria.every(value => typeof value === "string" && value.trim())) {
      throw new Error(`Task ${task.id} must include explicit, non-empty acceptance criteria.`);
    }
    return { id: task.id, title: task.title, scope: task.scope, targetFiles: task.targetFiles as string[], dependsOn: task.dependsOn as string[], acceptanceCriteria: task.acceptanceCriteria as string[], agentHint: typeof task.agentHint === "string" ? task.agentHint : undefined };
  });
  if (tasks.length === 0) throw new Error("Planner returned an empty task list.");
  for (const task of tasks) {
    for (const target of task.targetFiles) {
      const normalized = target.replace(/\\/g, "/");
      if (!normalized.trim() || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some(segment => segment === "..")) {
        throw new Error(`Task ${task.id} contains an unsafe workspace-relative target path: ${target}`);
      }
    }
  }
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  for (const task of tasks) for (const dependency of task.dependsOn) if (!ids.has(dependency)) throw new Error(`Unknown dependency ${dependency} in task ${task.id}`);
  createIndependentTasks(tasks);
  return tasks;
}
export async function requestOmniRoute<T>(path: string, body: unknown, config: AxiomRuntimeConfig = DEFAULT_AXIOM_RUNTIME, fetcher: typeof fetch = fetch): Promise<T> {
  const base = config.gatewayUrl.replace(/\/+$/, "");
  let lastError: unknown;
  for (let attempt = 0; attempt <= config.maxAutomaticRetries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    try {
      const response = await fetcher(`${base}/${path.replace(/^\/+/, "")}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`OmniRoute returned HTTP ${response.status}`);
      return await response.json() as T;
    } catch (error) {
      lastError = error;
      const advice = classifyRecovery(error);
      if (attempt >= config.maxAutomaticRetries || !advice.safeToRetryAutomatically) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(250 * 2 ** attempt, 1500)));
    } finally { clearTimeout(timeout); }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
