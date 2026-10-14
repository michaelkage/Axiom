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
  const remaining = new Map(tasks.map(task => [task.id, task]));
  const completed = new Set<string>();
  const batches: AxiomSubTask[][] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter(task => task.dependsOn.every(id => completed.has(id)));
    if (!ready.length) throw new Error("Task graph contains a dependency cycle or an unknown dependency.");
    batches.push(ready);
    for (const task of ready) { remaining.delete(task.id); completed.add(task.id); }
  }
  return batches;
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await fetcher(`${base}/${path.replace(/^\/+/, "")}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
    });
    if (!response.ok) throw new Error(`OmniRoute returned HTTP ${response.status}`);
    return await response.json() as T;
  } finally { clearTimeout(timeout); }
}
