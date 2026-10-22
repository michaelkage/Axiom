export type TurboWorkerStatus = "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out";
export interface TurboTask {
  id: string;
  title: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  attempts: number;
  maxAttempts: number;
  status: TurboWorkerStatus;
  lastError?: string;
}
export interface TurboPolicy {
  maxParallelWorkers: number;
  maxTotalAttempts: number;
  maxRuntimeMs: number;
  startedAt: number;
  now: number;
  stopRequested?: boolean;
}
export type TurboDecision =
  | { action: "stop"; reason: string }
  | { action: "complete"; reason: string }
  | { action: "dispatch" | "retry" | "replan" | "blocked"; taskIds: string[]; reason: string }
  | { action: "wait"; reason: string };

/** Deterministic supervisor policy. The host feeds real worker events and performs returned actions. */
export function decideTurboNext(tasks: TurboTask[], policy: TurboPolicy): TurboDecision {
  if (policy.stopRequested) return { action: "stop", reason: "Stop requested by the user." };
  if (policy.now - policy.startedAt >= policy.maxRuntimeMs) return { action: "stop", reason: "Turbo runtime budget exhausted." };
  const totalAttempts = tasks.reduce((sum, task) => sum + task.attempts, 0);
  if (totalAttempts >= policy.maxTotalAttempts && tasks.some(task => !["succeeded", "cancelled"].includes(task.status))) {
    return { action: "stop", reason: "Turbo total-attempt budget exhausted." };
  }
  if (!tasks.length) return { action: "blocked", taskIds: [], reason: "No tasks were supplied; create a plan before dispatching workers." };
  const byId = new Map(tasks.map(task => [task.id, task]));
  const missingDependencies = tasks.flatMap(task => task.dependsOn.filter(id => !byId.has(id)).map(id => task.id + " depends on missing task " + id));
  if (missingDependencies.length) return { action: "blocked", taskIds: [...new Set(missingDependencies)], reason: missingDependencies.join("; ") };

  const active = tasks.filter(task => task.status === "running").length;
  const failed = tasks.filter(task => task.status === "failed" || task.status === "timed_out");
  const retryable = failed.filter(task => task.attempts < task.maxAttempts);
  if (retryable.length && active < Math.max(1, policy.maxParallelWorkers)) {
    return { action: "retry", taskIds: retryable.slice(0, Math.max(1, policy.maxParallelWorkers) - active).map(task => task.id), reason: "Retry failed work within its per-task attempt limit." };
  }
  const exhausted = failed.filter(task => task.attempts >= task.maxAttempts);
  // Do not replan while sibling workers are still running: their eventual outcomes may
  // change which dependencies are blocked and what work remains. Drain active work first.
  if (exhausted.length && active > 0 && (retryable.length === 0 || active >= Math.max(1, policy.maxParallelWorkers))) {
    return { action: "wait", reason: "A task exhausted retries; wait for active workers to finish before replanning." };
  }
  const blocked = tasks.filter(task => {
    const dependenciesSucceeded = task.dependsOn.every(id => byId.get(id)!.status === "succeeded");
    if (task.status === "blocked" && dependenciesSucceeded) return false;
    return task.status === "blocked" || task.dependsOn.some(id => {
      const dependency = byId.get(id)!;
      return dependency.status === "blocked" || ((dependency.status === "failed" || dependency.status === "timed_out") && dependency.attempts >= dependency.maxAttempts);
    });
  });
  if (exhausted.length) return { action: "replan", taskIds: exhausted.map(task => task.id), reason: "A task exhausted retries; diagnose, split, or reassign it instead of looping." };
  if (blocked.length) return { action: "blocked", taskIds: blocked.map(task => task.id), reason: "Some tasks are blocked by unresolved dependencies." };
  const ready = tasks.filter(task => (task.status === "queued" || task.status === "blocked") && task.dependsOn.every(id => byId.get(id)!.status === "succeeded"));
  const slots = Math.max(0, policy.maxParallelWorkers - active);
  if (ready.length && slots > 0) return { action: "dispatch", taskIds: ready.slice(0, slots).map(task => task.id), reason: "Dispatch dependency-ready tasks within the parallel-worker limit." };
  if (tasks.every(task => task.status === "succeeded")) return { action: "complete", reason: "All planned tasks succeeded; verify overall acceptance criteria before declaring the goal complete." };
  if (active > 0) return { action: "wait", reason: "Workers are still running; wait for their next lifecycle or diagnostic event." };
  return { action: "blocked", taskIds: tasks.filter(task => task.status !== "succeeded").map(task => task.id), reason: "No task is runnable. Inspect diagnostics and replan." };
}
