import type { AxiomSubTask } from "./axiomRuntime";

export interface TaskGraphNode extends AxiomSubTask {
  status?: "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out";
}
export interface TaskGraphIssue { taskId: string; code: "duplicate-id" | "unknown-dependency" | "cycle" | "scope-conflict" | "invalid-scope"; message: string; }
export interface TaskGraphAnalysis {
  valid: boolean;
  issues: TaskGraphIssue[];
  topologicalOrder: string[];
  readyTaskIds: string[];
  blockedTaskIds: string[];
  layers: string[][];
}
const terminal = new Set(["succeeded", "failed", "blocked", "cancelled", "timed_out"]);
function normalizedScope(paths: string[]): string[] {
  return paths.map(path => {
    if (typeof path !== "string" || !path.trim() || path.length > 512 || path.startsWith("/") || /^[a-z]:/i.test(path) || path.includes("\0")) throw new Error("invalid-scope");
    const normalized = path.replace(/\\/g, "/");
    const parts = normalized.split("/");
    if (parts.some(part => !part || part === "." || part === "..")) throw new Error("invalid-scope");
    return normalized.toLocaleLowerCase("en-US");
  });
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b.endsWith("/") ? b : b + "/") || b.startsWith(a.endsWith("/") ? a : a + "/");
}

/** Analyze dependency health and produce deterministic dependency layers. */
export function analyzeTaskGraph(tasks: readonly TaskGraphNode[]): TaskGraphAnalysis {
  const issues: TaskGraphIssue[] = [];
  const byId = new Map<string, TaskGraphNode>();
  for (const task of tasks) {
    if (!task.id || byId.has(task.id)) issues.push({ taskId: task.id || "", code: "duplicate-id", message: "Task IDs must be non-empty and unique." });
    else byId.set(task.id, task);
    try { normalizedScope(task.targetFiles); } catch {
      issues.push({ taskId: task.id, code: "invalid-scope", message: "Task target paths must be safe, normalized workspace-relative paths." });
    }
  }
  for (const task of byId.values()) {
    for (const dep of task.dependsOn) if (!byId.has(dep)) issues.push({ taskId: task.id, code: "unknown-dependency", message: "Unknown dependency: " + dep });
    if (new Set(task.dependsOn).size !== task.dependsOn.length) issues.push({ taskId: task.id, code: "unknown-dependency", message: "Duplicate dependency edges are not allowed." });
  }
  if (issues.length) return { valid: false, issues, topologicalOrder: [], readyTaskIds: [], blockedTaskIds: [], layers: [] };

  const indegree = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const task of byId.values()) {
    const deps = task.dependsOn.filter(id => !terminal.has(byId.get(id)?.status ?? "queued") || byId.get(id)?.status !== "succeeded");
    indegree.set(task.id, deps.length);
    for (const dep of task.dependsOn) children.set(dep, [...(children.get(dep) ?? []), task.id]);
  }
  const remaining = new Set(byId.keys());
  const order: string[] = [];
  const layers: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(id => (indegree.get(id) ?? 0) === 0).sort();
    if (!ready.length) {
      issues.push({ taskId: "", code: "cycle", message: "Task dependencies contain a cycle." });
      return { valid: false, issues, topologicalOrder: [], readyTaskIds: [], blockedTaskIds: [], layers: [] };
    }
    // A dependency layer is a logical set. The executor still applies file-scope conflict serialization.
    layers.push(ready);
    for (const id of ready) {
      remaining.delete(id); order.push(id);
      for (const child of children.get(id) ?? []) indegree.set(child, (indegree.get(child) ?? 0) - 1);
    }
  }

  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of byId.values()) {
      if (blocked.has(task.id)) continue;
      if (task.dependsOn.some(dep => {
        const dependency = byId.get(dep)!;
        return blocked.has(dep) || ["failed", "blocked", "cancelled", "timed_out"].includes(dependency.status ?? "queued");
      })) { blocked.add(task.id); changed = true; }
    }
  }
  const readyTaskIds = [...byId.values()].filter(task =>
    (task.status ?? "queued") === "queued" && task.dependsOn.every(dep => byId.get(dep)?.status === "succeeded")
  ).map(task => task.id).sort();
  return { valid: true, issues: [], topologicalOrder: order, readyTaskIds, blockedTaskIds: [...blocked].sort(), layers };
}

/** Pick a conflict-free worker batch from currently runnable tasks. */
export function selectRunnableTaskBatch(tasks: readonly TaskGraphNode[], maxWorkers: number): TaskGraphNode[] {
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 100) throw new RangeError("maxWorkers must be an integer between 1 and 100.");
  const analysis = analyzeTaskGraph(tasks);
  if (!analysis.valid) throw new Error(analysis.issues.map(issue => issue.message).join(" "));
  const byId = new Map(tasks.map(task => [task.id, task]));
  const selected: TaskGraphNode[] = [];
  const claimed: string[] = [];
  for (const id of analysis.readyTaskIds) {
    if (selected.length >= maxWorkers) break;
    const task = byId.get(id)!;
    if (!task.targetFiles.length) {
      if (selected.length === 0) selected.push(task);
      break;
    }
    const scope = normalizedScope(task.targetFiles);
    if (scope.some(path => claimed.some(existing => overlaps(path, existing)))) continue;
    selected.push(task);
    claimed.push(...scope);
  }
  return selected;
}

/** Replan only the affected dependency closure; independent work remains eligible. */
export function getFailureImpact(tasks: readonly TaskGraphNode[], failedTaskIds: readonly string[]): { affected: string[]; unaffected: string[] } {
  const analysis = analyzeTaskGraph(tasks);
  if (!analysis.valid) throw new Error("Cannot calculate failure impact for an invalid task graph.");
  const byId = new Map(tasks.map(task => [task.id, task]));
  const affected = new Set(failedTaskIds);
  for (const id of failedTaskIds) if (!byId.has(id)) throw new Error("Unknown failed task: " + id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) if (!affected.has(task.id) && task.dependsOn.some(dep => affected.has(dep))) {
      affected.add(task.id); changed = true;
    }
  }
  return { affected: [...affected].sort(), unaffected: tasks.map(task => task.id).filter(id => !affected.has(id)).sort() };
}
