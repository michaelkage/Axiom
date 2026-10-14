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
      if (batch.some(item => item.targetFiles.length === 0) || paths.some(path => claimedPaths.has(path))) continue;
      batch.push(task);
      for (const path of paths) claimedPaths.add(path);
    }
    if (!batch.length) throw new Error("Task graph could not be scheduled safely.");
    batches.push(batch);
    for (const task of batch) { remaining.delete(task.id); completed.add(task.id); }
  }
  return batches;
}

export async function executeTaskBatches<T>(
  tasks: AxiomSubTask[],
  runner: (task: AxiomSubTask) => Promise<T>,
): Promise<Array<{ task: AxiomSubTask; result: T }>> {
  const completed: Array<{ task: AxiomSubTask; result: T }> = [];
  for (const batch of createIndependentTasks(tasks)) {
    const settled = await Promise.allSettled(batch.map(async task => ({ task, result: await runner(task) })));
    const failure = settled.find((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failure) throw new Error(`Parallel task batch failed: ${String(failure.reason instanceof Error ? failure.reason.message : failure.reason)}`);
    for (const entry of settled) {
      if (entry.status === "fulfilled") completed.push(entry.value);
    }
  }
  return completed;
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
      { role: "system", content: "Split the user request into small independent coding tasks. Return only a JSON object with a tasks array. Each task must have id, title, scope, targetFiles (array of workspace-relative file paths), dependsOn (array of task IDs), and optional agentHint. Use disjoint targetFiles for tasks that can run in parallel. Never invent absolute paths. If a task's files are uncertain, use a narrow, explicit likely path and keep the task small." },
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
    return { id: task.id, title: task.title, scope: task.scope, targetFiles: task.targetFiles as string[], dependsOn: task.dependsOn as string[], agentHint: typeof task.agentHint === "string" ? task.agentHint : undefined };
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
