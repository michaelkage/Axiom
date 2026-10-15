import { getAxiomConfig } from "./axiomConfig";
import { OmniRouteClient } from "./omniRouteClient";

export interface AxiomSubTask {
  id: string;
  scope: string;
  description: string;
  targetFiles: string[];
  dependsOn: string[];
}

export type TaskState = "pending" | "running" | "completed" | "failed" | "blocked";
export interface TaskResult {
  task: AxiomSubTask;
  state: TaskState;
  output?: string;
  error?: string;
}
export type WorkerExecutor = (task: AxiomSubTask, signal: AbortSignal) => Promise<string>;

function parseTasks(raw: string): AxiomSubTask[] {
  const normalized = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(normalized);
  if (!Array.isArray(parsed)) throw new Error("Planner output must be a JSON array");
  const tasks = parsed.map((item, index): AxiomSubTask => {
    if (!item || typeof item !== "object") throw new Error(`Task ${index} is not an object`);
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id : `task-${index + 1}`;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error(`Invalid task id: ${id}`);
    if (typeof value.scope !== "string" || !value.scope.trim()) throw new Error(`Task ${id} needs a scope`);
    if (typeof value.description !== "string" || !value.description.trim()) throw new Error(`Task ${id} needs a description`);
    const targetFiles = Array.isArray(value.targetFiles)
      ? value.targetFiles.filter((v): v is string => typeof v === "string").slice(0, 100)
      : [];
    const dependsOn = Array.isArray(value.dependsOn)
      ? value.dependsOn.filter((v): v is string => typeof v === "string")
      : [];
    return { id, scope: value.scope, description: value.description, targetFiles, dependsOn };
  });
  const ids = new Set(tasks.map(task => task.id));
  if (ids.size !== tasks.length) throw new Error("Planner returned duplicate task IDs");
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`);
      if (dependency === task.id) throw new Error(`Task ${task.id} cannot depend on itself`);
    }
  }
  // Reject dependency cycles before executing any work.
  const visiting = new Set<string>(), visited = new Set<string>();
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Planner returned cyclic task dependencies");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of byId.get(id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}

export class AxiomOrchestrator {
  constructor(
    private readonly gateway = new OmniRouteClient(),
    private readonly executeWorker: WorkerExecutor,
  ) {}

  async plan(goal: string, workspaceContext: unknown, signal?: AbortSignal): Promise<AxiomSubTask[]> {
    const config = getAxiomConfig();
    const response = await this.gateway.chat([
      { role: "system", content: "You are Axiom's task planner. Return only a JSON array. Each item must have id, scope, description, targetFiles (string array), and dependsOn (string array). Create small, non-overlapping tasks. Do not claim that work has been executed." },
      { role: "user", content: JSON.stringify({ goal, workspaceContext }) },
    ], { model: config.plannerModel, temperature: 0, signal });
    return parseTasks(response);
  }

  async run(tasks: AxiomSubTask[], signal?: AbortSignal, onUpdate?: (result: TaskResult) => void): Promise<TaskResult[]> {
    const config = getAxiomConfig();
    const results = new Map<string, TaskResult>();
    const pending = new Map(tasks.map(task => [task.id, task]));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const emit = (result: TaskResult) => { results.set(result.task.id, result); onUpdate?.(result); };

    try {
      while (pending.size > 0) {
        if (controller.signal.aborted) {
          for (const task of pending.values()) emit({ task, state: "blocked", error: "Execution cancelled" });
          break;
        }
        let progressed = false;
        const ready: AxiomSubTask[] = [];
        for (const task of pending.values()) {
          const dependencies = task.dependsOn.map(id => results.get(id));
          if (dependencies.some(result => result && ["failed", "blocked"].includes(result.state))) {
            pending.delete(task.id); emit({ task, state: "blocked", error: "A dependency did not complete" }); progressed = true;
          } else if (dependencies.every(result => result?.state === "completed")) {
            ready.push(task);
          }
        }
        if (!ready.length) {
          if (pending.size && !progressed) {
            for (const task of pending.values()) emit({ task, state: "blocked", error: "Unresolvable dependency state" });
            break;
          }
          continue;
        }
        const batch = ready.slice(0, config.enableSubAgents ? config.maxConcurrentWorkers : 1);
        await Promise.all(batch.map(async task => {
          pending.delete(task.id);
          emit({ task, state: "running" });
          try {
            const output = await this.executeWorker(task, controller.signal);
            emit({ task, state: "completed", output });
          } catch (error) {
            emit({ task, state: "failed", error: error instanceof Error ? error.message : String(error) });
          }
        }));
      }
      return tasks.map(task => results.get(task.id) ?? { task, state: "blocked", error: "No result produced" });
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }
}
