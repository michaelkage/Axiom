export type QualityStatus = "Ready to review" | "Needs fixes" | "Blocked";
export type CheckState = "passed" | "failed" | "unverified" | "skipped";
export interface QualityCheck { name: string; state: CheckState; exitCode?: number; output?: string; }
export interface FileChange { path: string; status?: "added" | "modified" | "deleted" | "renamed"; patch?: string; }
export interface QualityGateInput {
  checks: QualityCheck[];
  changes: FileChange[];
  expectedPaths?: string[];
  unfinishedRequirements?: string[];
  blockedReason?: string;
}
export interface QualityGateResult {
  status: QualityStatus;
  checks: QualityCheck[];
  unexpectedPaths: string[];
  unfinishedRequirements: string[];
  reasons: string[];
}
const normalizePath = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();

/** A task is review-ready only when every required check has explicit passing evidence. */
export function evaluateQualityGate(input: QualityGateInput): QualityGateResult {
  const expected = new Set((input.expectedPaths ?? []).map(normalizePath));
  const unexpectedPaths = expected.size ? input.changes.map(c => c.path).filter(p => !expected.has(normalizePath(p))) : [];
  const unfinishedRequirements = [...(input.unfinishedRequirements ?? [])];
  const failed = input.checks.some(c => c.state === "failed" || (c.exitCode !== undefined && c.exitCode !== 0));
  const unverified = input.checks.some(c => c.state === "unverified" || c.state === "skipped" || c.exitCode === undefined && c.state !== "passed");
  const reasons: string[] = [];
  if (input.blockedReason) reasons.push(input.blockedReason);
  if (failed) reasons.push("One or more verification checks failed.");
  if (unverified) reasons.push("One or more checks lack passing evidence.");
  if (unexpectedPaths.length) reasons.push("The diff contains files outside the declared scope.");
  if (unfinishedRequirements.length) reasons.push("Acceptance criteria remain unfinished.");
  return {
    status: input.blockedReason ? "Blocked" : failed || unverified || unexpectedPaths.length > 0 || unfinishedRequirements.length ? "Needs fixes" : "Ready to review",
    checks: input.checks.map(c => ({ ...c })), unexpectedPaths, unfinishedRequirements, reasons,
  };
}

export interface AcceptanceCriterion { id: string; description: string; }
export interface PlannedTask {
  id: string; title: string; scope: string; targetFiles: string[]; dependsOn: string[];
  acceptanceCriteria: AcceptanceCriterion[]; agentHint?: string;
}
export interface TaskOutcome { taskId: string; status: "succeeded" | "failed" | "blocked"; summary?: string; }
export function validateTaskPlan(tasks: PlannedTask[]): PlannedTask[] {
  if (!tasks.length) throw new Error("Task plan cannot be empty.");
  const byId = new Map<string, PlannedTask>();
  for (const task of tasks) {
    if (!task.id.trim() || byId.has(task.id)) throw new Error(`Duplicate or empty task id: ${task.id}`);
    if (!task.title.trim() || !task.scope.trim()) throw new Error(`Task ${task.id} needs a title and scope.`);
    if (!task.acceptanceCriteria.length || task.acceptanceCriteria.some(c => !c.id.trim() || !c.description.trim())) throw new Error(`Task ${task.id} needs explicit acceptance criteria.`);
    for (const file of task.targetFiles) {
      const path = normalizePath(file);
      if (!path || path === ".." || path.startsWith("../") || path.startsWith("/")) throw new Error(`Unsafe target path in task ${task.id}: ${file}`);
    }
    byId.set(task.id, task);
  }
  for (const task of tasks) for (const dep of task.dependsOn) {
    if (!byId.has(dep)) throw new Error(`Unknown dependency ${dep} in task ${task.id}`);
    if (dep === task.id) throw new Error(`Task ${task.id} cannot depend on itself.`);
  }
  const visiting = new Set<string>(), visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error("Task plan contains a dependency cycle.");
    if (visited.has(id)) return;
    visiting.add(id); for (const dep of byId.get(id)!.dependsOn) visit(dep);
    visiting.delete(id); visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return tasks.map(t => ({ ...t, targetFiles: [...t.targetFiles], dependsOn: [...t.dependsOn], acceptanceCriteria: t.acceptanceCriteria.map(c => ({ ...c })) }));
}

/** Reconcile actual task outcomes and block only downstream dependents of failed work. */
export function replanAfterOutcomes<T extends { id: string; dependsOn: string[] }>(tasks: T[], outcomes: TaskOutcome[]) {
  const outcomeById = new Map(outcomes.map(o => [o.taskId, o]));
  const failed = tasks.filter(t => ["failed", "blocked"].includes(outcomeById.get(t.id)?.status ?? "")).map(t => t.id);
  const completed = tasks.filter(t => outcomeById.get(t.id)?.status === "succeeded").map(t => t.id);
  const blocked = new Set<string>(); let changed = true;
  while (changed) {
    changed = false;
    for (const task of tasks) if (!blocked.has(task.id) && task.dependsOn.some(dep => failed.includes(dep) || blocked.has(dep))) { blocked.add(task.id); changed = true; }
  }
  return { completed, failed, blocked: [...blocked], remaining: tasks.filter(t => !completed.includes(t.id) && !failed.includes(t.id) && !blocked.has(t.id)) };
}

export interface ReviewableTask { taskId: string; summary: string; changes: FileChange[]; quality: QualityGateResult; }
export function reviewTaskResults(results: ReviewableTask[]) {
  return results.map(result => ({ ...result, changedFiles: result.changes.map(c => c.path), canAccept: result.quality.status === "Ready to review", decision: "pending" as "pending" | "accepted" | "rejected" }));
}
/** Prepare a selective integration manifest. This deliberately does not execute git or overwrite files. */
export function selectIntegrationChanges(acceptedTaskIds: string[], results: ReviewableTask[], unrelatedDirtyPaths: string[] = []) {
  const accepted = new Set(acceptedTaskIds), selected = results.filter(r => accepted.has(r.taskId));
  const changes = selected.flatMap(r => r.changes), seen = new Set<string>(), conflicts: string[] = [];
  for (const change of changes) { const path = normalizePath(change.path); if (seen.has(path) && !conflicts.includes(change.path)) conflicts.push(change.path); seen.add(path); }
  return { changes, conflicts, unrelatedDirtyPaths: [...unrelatedDirtyPaths], safeToApply: conflicts.length === 0 && selected.every(r => r.quality.status === "Ready to review") };
}

export interface ProjectMemory {
  id: string; category: "architecture" | "convention" | "decision" | "preference" | "fix" | "failure";
  content: string; tags: string[]; createdAt: string; updatedAt: string;
}
export interface ProjectMemoryStore { load(): Promise<ProjectMemory[]>; save(memories: ProjectMemory[]): Promise<void>; }
export async function rememberProjectFact(store: ProjectMemoryStore, memory: ProjectMemory): Promise<void> {
  const current = await store.load(), index = current.findIndex(item => item.id === memory.id);
  if (index >= 0) current[index] = { ...memory, updatedAt: new Date().toISOString() }; else current.push(memory);
  await store.save(current);
}
export async function forgetProjectMemory(store: ProjectMemoryStore, id: string): Promise<boolean> {
  const current = await store.load(), next = current.filter(item => item.id !== id);
  if (next.length === current.length) return false;
  await store.save(next); return true;
}
export function retrieveProjectMemories(memories: ProjectMemory[], query: string, limit = 5): ProjectMemory[] {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_-]+/).filter(t => t.length > 2))];
  if (!terms.length || limit <= 0) return [];
  return memories.map((memory, index) => {
    const text = [memory.category, memory.content, ...memory.tags].join(" ").toLowerCase();
    const score = terms.reduce((sum, term) => sum + (text.includes(term) ? memory.tags.some(tag => tag.toLowerCase().includes(term)) ? 3 : 1 : 0), 0);
    return { memory, index, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit).map(x => x.memory);
}

export interface BuildOutcome {
  title: string; completedRequirements: string[]; outstandingRequirements: string[];
  changedFiles: string[]; checks: QualityCheck[]; previewUrl?: string;
}
export function summarizeBuildOutcome(outcome: BuildOutcome) {
  const passedChecks = outcome.checks.filter(c => c.state === "passed").map(c => c.name);
  const outstandingChecks = outcome.checks.filter(c => c.state !== "passed").map(c => c.name);
  return {
    title: outcome.title,
    status: outcome.outstandingRequirements.length || outstandingChecks.length ? "Needs attention" as const : "Ready to review" as const,
    completedRequirements: [...outcome.completedRequirements], outstandingRequirements: [...outcome.outstandingRequirements],
    changedFiles: [...new Set(outcome.changedFiles)], passedChecks, outstandingChecks, previewUrl: outcome.previewUrl,
    suggestedNextSteps: [
      ...(outcome.outstandingRequirements.length ? ["Complete the outstanding acceptance criteria."] : []),
      ...(outstandingChecks.length ? ["Resolve checks without passing evidence."] : []),
      ...(!outcome.previewUrl ? ["Generate a preview or screenshot when supported."] : []),
    ],
  };
}
