/**
 * Axiom Intelligence Layer: deterministic orchestration, context selection,
 * reusable combos, proactive next steps, and a permission-aware plugin catalog.
 *
 * This module deliberately contains policy/data logic only. Runtime execution
 * remains in the OpenCode host; plugin discovery never evaluates downloaded code.
 */
export type SpecialistRole = "research" | "implementation" | "debugging" | "testing" | "review";

export interface IntelligenceTask {
  id: string;
  title: string;
  prompt: string;
  role: SpecialistRole;
  dependsOn: string[];
  targetFiles: string[];
}
export interface TaskSignal {
  id: string;
  title: string;
  prompt: string;
  targetFiles?: string[];
  dependsOn?: string[];
  kind?: "feature" | "bug" | "question" | "test" | "review";
}
const roleRules: Array<{ role: SpecialistRole; pattern: RegExp }> = [
  { role: "debugging", pattern: /\b(debug|bug|broken|crash|error|fix|failing|regression)\b/i },
  { role: "testing", pattern: /\b(test|tests|testing|coverage|verify|verification)\b/i },
  { role: "review", pattern: /\b(review|audit|security|quality|risk)\b/i },
  { role: "research", pattern: /\b(explain|understand|investigate|research|compare|architecture|how does)\b/i },
];
export function inferSpecialist(prompt: string): SpecialistRole {
  return roleRules.find(rule => rule.pattern.test(prompt))?.role ?? "implementation";
}

/** Produce bounded, dependency-aware tasks with stable IDs and explicit scopes. */
export function coordinateTasks(signals: TaskSignal[]): IntelligenceTask[] {
  const seen = new Set<string>();
  const tasks = signals.map((signal, index) => {
    const id = signal.id.trim();
    if (!id || seen.has(id)) throw new Error(`Task IDs must be non-empty and unique: ${id}`);
    seen.add(id);
    return {
      id,
      title: signal.title.trim() || `Task ${index + 1}`,
      prompt: signal.prompt.trim(),
      role: signal.kind === "test" ? "testing" : signal.kind === "review" ? "review" : inferSpecialist(signal.prompt),
      dependsOn: [...(signal.dependsOn ?? [])],
      targetFiles: [...new Set((signal.targetFiles ?? []).map(path => normalizeWorkspacePath(path)))],
    };
  });
  const ids = new Set(seen);
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) throw new Error("Unknown dependency " + dependency + " in task " + task.id);
      if (dependency === task.id) throw new Error("Task " + task.id + " cannot depend on itself");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map<string, IntelligenceTask>(tasks.map(task => [task.id, task] as const));
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("Task graph contains a dependency cycle.");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
  return tasks;
}
export function normalizeWorkspacePath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized) || normalized.split("/").some(part => part === "..")) {
    throw new Error(`Unsafe workspace-relative path: ${path}`);
  }
  return normalized;
}

export interface ContextItem {
  id: string;
  content: string;
  kind: "decision" | "constraint" | "error" | "open-task" | "file" | "tool-output" | "conversation";
  relevance: number;
  updatedAt?: number;
}
export interface PackedContext {
  items: ContextItem[];
  estimatedTokens: number;
  inputEstimatedTokens: number;
  estimatedSavingsTokens: number;
  estimatedSavingsPercent: number;
  omittedIds: string[];
}
export interface ContextFilterOptions {
  now?: number;
  maxAgeMs?: number;
  excludedPaths?: string[];
}
export interface ContextFilterResult {
  included: ContextItem[];
  excluded: Array<{ id: string; reason: "stale" | "ignored-path" | "sensitive-content" }>;
}
const SECRET_CONTENT_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
];
/** Filter persisted/retrieved context before packing; return reasons so omissions are inspectable. */
export function filterProjectContext(items: ContextItem[], options: ContextFilterOptions = {}): ContextFilterResult {
  const now = options.now ?? Date.now();
  const excludedPaths = (options.excludedPaths ?? []).map(normalizeWorkspacePath).map(path => path.toLowerCase());
  const included: ContextItem[] = [];
  const excluded: ContextFilterResult["excluded"] = [];
  for (const item of items) {
    const normalizedId = item.id.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const normalizedContent = item.content.replace(/\\/g, "/");
    if (excludedPaths.some(path => normalizedId === path || normalizedId.startsWith(path + "/"))) {
      excluded.push({ id: item.id, reason: "ignored-path" }); continue;
    }
    if (/(^|\/)(?:\.git|node_modules|dist|out|coverage)(\/|$)/i.test(normalizedId) ||
        /(^|\/)(?:\.env(?:\.[^/]*)?|[^/]*(?:secret|credential|private[-_]?key)[^/]*)$/i.test(normalizedId)) {
      excluded.push({ id: item.id, reason: "ignored-path" }); continue;
    }
    if (SECRET_CONTENT_PATTERNS.some(pattern => pattern.test(normalizedContent))) {
      excluded.push({ id: item.id, reason: "sensitive-content" }); continue;
    }
    if (options.maxAgeMs !== undefined && item.updatedAt !== undefined && now - item.updatedAt > options.maxAgeMs) {
      excluded.push({ id: item.id, reason: "stale" }); continue;
    }
    included.push({ ...item });
  }
  return { included, excluded };
}
const PRIORITY: Record<ContextItem["kind"], number> = {
  constraint: 7, decision: 6, "open-task": 5, error: 4, file: 3, conversation: 2, "tool-output": 1,
};
/** Cheap conservative heuristic; label as estimated, never as provider-measured tokens. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
export function packContext(items: ContextItem[], tokenBudget: number): PackedContext {
  if (!Number.isFinite(tokenBudget) || tokenBudget < 1) throw new Error("Context token budget must be a positive number.");
  const deduped = new Map<string, ContextItem>();
  for (const item of items) {
    const prior = deduped.get(item.id);
    if (!prior || (item.updatedAt ?? 0) >= (prior.updatedAt ?? 0)) deduped.set(item.id, item);
  }
  const ranked = [...deduped.values()].sort((a, b) =>
    (PRIORITY[b.kind] * 100 + clamp(b.relevance, 0, 99)) - (PRIORITY[a.kind] * 100 + clamp(a.relevance, 0, 99))
  );
  const selected: ContextItem[] = [];
  const omittedIds: string[] = [];
  const inputEstimatedTokens = ranked.reduce((total, item) => total + estimateTokens(item.content), 0);
  let estimatedTokens = 0;
  for (const item of ranked) {
    const cost = estimateTokens(item.content);
    if (estimatedTokens + cost <= tokenBudget) {
      selected.push(item);
      estimatedTokens += cost;
    } else omittedIds.push(item.id);
  }
  const estimatedSavingsTokens = Math.max(0, inputEstimatedTokens - estimatedTokens);
  const estimatedSavingsPercent = inputEstimatedTokens > 0 ? Math.round(estimatedSavingsTokens / inputEstimatedTokens * 100) : 0;
  return { items: selected, estimatedTokens, inputEstimatedTokens, estimatedSavingsTokens, estimatedSavingsPercent, omittedIds };
}
function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}

export type ComboStep = "diagnose" | "implement" | "test" | "summarize" | "review" | "release-notes" | "map-architecture" | "explain";
export interface AxiomCombo {
  id: string;
  title: string;
  description: string;
  prompt: string;
  steps: ComboStep[];
  requiresConfirmation?: boolean;
}
export const DEFAULT_COMBOS: AxiomCombo[] = [
  { id: "fix-it", title: "Fix it", description: "Find the cause, make a focused fix, and verify it.", prompt: "Diagnose the issue, implement the smallest safe fix, run relevant checks, and summarize the result and any unverified checks.", steps: ["diagnose", "implement", "test", "summarize"] },
  { id: "ship-it", title: "Ship it", description: "Review changes and prepare release-ready notes.", prompt: "Review the current changes for regressions and risks, run relevant checks, and draft concise release notes. Do not publish or deploy without explicit approval.", steps: ["review", "test", "release-notes"], requiresConfirmation: true },
  { id: "understand-it", title: "Understand it", description: "Map the relevant architecture and explain it clearly.", prompt: "Inspect the relevant code, map the architecture and important data flows, then explain the design and likely change points without modifying files.", steps: ["map-architecture", "explain"] },
];
export function getAvailableCombos(installedPluginIds: string[]): AxiomCombo[] {
  const combos = [...DEFAULT_COMBOS];
  if (installedPluginIds.includes("axiom-review-workflows")) {
    combos.push({
      id: "review-it",
      title: "Review it",
      description: "Review the current changes and focus on regressions, security, and test gaps.",
      prompt: "Review the current workspace changes for regressions, security concerns, missing edge cases, and test gaps. Prioritize concrete findings with file references. Do not modify files unless asked.",
      steps: ["review", "test", "summarize"],
    });
  }
  return combos;
}

export function getCombo(id: string, combos: AxiomCombo[] = DEFAULT_COMBOS): AxiomCombo {
  const combo = combos.find(item => item.id === id);
  if (!combo) throw new Error(`Unknown Axiom combo: ${id}`);
  return combo;
}

export interface NextAction {
  id: string;
  label: string;
  reason: string;
  prompt: string;
  priority: number;
}
export function suggestNextActions(input: { lastFailure?: string; changedFiles?: string[]; checksPassed?: boolean; hasPlan?: boolean; taskOutcomes?: Array<{ title: string; status: string; error?: string }> }): NextAction[] {
  const actions: NextAction[] = [];
  const failedTasks = (input.taskOutcomes ?? []).filter(task => task.status === "failed");
  const pendingTasks = (input.taskOutcomes ?? []).filter(task => task.status === "queued" || task.status === "running");
  if (failedTasks.length) actions.push({ id: "retry-failed-tasks", label: "Resolve failed tasks", reason: failedTasks.length + " task(s) failed.", prompt: "Investigate and fix these failed agent tasks without replaying completed side effects:\n" + failedTasks.map(task => "- " + task.title + ": " + (task.error ?? "failure details unavailable")).join("\n"), priority: 110 });
  if (pendingTasks.length) actions.push({ id: "check-running-tasks", label: "Check task progress", reason: pendingTasks.length + " task(s) remain queued or running.", prompt: "Inspect the current agent task outcomes and continue only tasks that are still pending. Report observed statuses.", priority: 95 });
  if (input.lastFailure) actions.push({ id: "diagnose-failure", label: "Diagnose failure", reason: "The last operation reported an error.", prompt: `Diagnose this failure without repeating side-effecting actions: ${input.lastFailure}`, priority: 100 });
  if (input.hasPlan) actions.push({ id: "run-plan", label: "Continue plan", reason: "A prepared plan is ready to run.", prompt: "Continue with the prepared plan and report each task outcome.", priority: 80 });
  if ((input.changedFiles?.length ?? 0) > 0 && input.checksPassed !== true) actions.push({ id: "verify-changes", label: "Verify changes", reason: "Workspace changes exist without confirmed passing checks.", prompt: "Run the relevant tests and build, and report only outcomes supported by observed exit statuses.", priority: 70 });
  if ((input.changedFiles?.length ?? 0) > 0 && input.checksPassed === true) actions.push({ id: "review-changes", label: "Review changes", reason: "Checks passed; a final risk-focused review is useful.", prompt: "Review the changed files for regressions, edge cases, and unintended scope.", priority: 50 });
  if (!actions.length) actions.push({ id: "clarify-goal", label: "Choose a direction", reason: "No pending plan, failure, or unverified change was detected.", prompt: "Summarize the current state and suggest the most useful next step.", priority: 10 });
  return actions.sort((a, b) => b.priority - a.priority);
}

export interface ExecutionSummary {
  taskId: string; title: string; status: "queued" | "running" | "succeeded" | "failed" | "blocked" | "cancelled" | "timed_out";
  error?: string; summary?: string; sessionId?: string; agent?: string;
}
export function contextForSpecialist(input: {
  request: string; taskTitle: string; taskScope: string; targetFiles: string[];
  planSteps?: string[]; completedTasks?: Array<{ title: string; status: string; summary?: string; error?: string }>;
  constraints?: string[]; tokenBudget?: number;
  conversation?: Array<{ id: string; content: string; relevance?: number; updatedAt?: number }>;
  projectMemories?: Array<{ id: string; content: string; relevance?: number; updatedAt?: number }>;
}): PackedContext {
  const items: ContextItem[] = [
    { id: "request", content: "Original request: " + input.request, kind: "constraint", relevance: 99 },
    { id: "task", content: "Assigned task: " + input.taskTitle + "\nScope: " + input.taskScope, kind: "open-task", relevance: 99 },
    { id: "targets", content: "Declared target files: " + (input.targetFiles.join(", ") || "No target files declared; minimize scope."), kind: "constraint", relevance: 98 },
    ...(input.planSteps ?? []).map((step, index) => ({ id: "plan-" + index, content: "Plan step " + (index + 1) + ": " + step, kind: "decision" as const, relevance: 80 })),
    ...(input.constraints ?? []).map((value, index) => ({ id: "constraint-" + index, content: value, kind: "constraint" as const, relevance: 95 })),
    ...(input.conversation ?? []).map((message, index) => ({ id: "conversation-" + message.id + "-" + index, content: message.content, kind: "conversation" as const, relevance: message.relevance ?? 50, updatedAt: message.updatedAt })),
    ...(input.projectMemories ?? []).map((memory, index) => ({ id: "project-memory-" + memory.id + "-" + index, content: "Relevant saved project memory: " + memory.content, kind: "decision" as const, relevance: memory.relevance ?? 85, updatedAt: memory.updatedAt })),
    ...(input.completedTasks ?? []).map((task, index) => ({ id: "completed-" + index, content: "Prior task: " + task.title + " [" + task.status + "]" + (task.summary ? "\nSummary: " + task.summary : "") + (task.error ? "\nError: " + task.error : ""), kind: task.error ? "error" as const : "decision" as const, relevance: 75 })),
  ];
  return packContext(items, input.tokenBudget ?? 4000);
}

export function comboPromptForState(combo: AxiomCombo, outcomes: ExecutionSummary[]): string {
  const succeeded = outcomes.filter(item => item.status === "succeeded");
  const failed = outcomes.filter(item => item.status === "failed");
  const pending = outcomes.filter(item => item.status === "queued" || item.status === "running");
  const status = [
    "Observed task outcomes (use these as evidence; do not assume unreported checks passed):",
    ...outcomes.map(item => "- " + item.title + ": " + item.status + (item.error ? " — " + item.error : "") + (item.summary ? " — " + item.summary : "")),
    "Totals: " + succeeded.length + " succeeded, " + failed.length + " failed, " + pending.length + " pending/running.",
  ].join("\n");
  return combo.prompt + "\n\n" + status + "\n\nIf any tasks failed or remain pending, address or clearly report them before claiming completion. Never claim a check passed without an observed successful exit status.";
}

export const BUILTIN_PLUGIN_CATALOG: PluginManifest[] = [
  { id: "axiom-context-tools", version: "1.0.0", publisher: "Axiom", description: "Context packing and task summary utilities.", permissions: ["read-files"], verified: true, sourceUrl: "https://github.com/michaelkage/Axiom" },
  { id: "axiom-review-workflows", version: "1.0.0", publisher: "Axiom", description: "Reusable review and release-note workflow templates.", permissions: ["read-files"], verified: true, sourceUrl: "https://github.com/michaelkage/Axiom" },
  { id: "community-command-runner", version: "community", publisher: "Community", description: "Illustrative third-party command-runner manifest. Not installed or executable from the catalog.", permissions: ["read-files", "run-commands", "network"], verified: false },
];

export interface PluginManifest {
  id: string;
  version: string;
  description: string;
  publisher: string;
  permissions: Array<"read-files" | "write-files" | "run-commands" | "network" | "models">;
  sourceUrl?: string;
  verified?: boolean;
}
export interface PluginReview {
  installable: boolean;
  warnings: string[];
  requiredApprovals: string[];
}
/** Catalog review only: no install or execution occurs here. */
export function reviewPluginManifest(manifest: PluginManifest): PluginReview {
  const warnings: string[] = [];
  const requiredApprovals: string[] = [];
  const candidate = manifest as Partial<PluginManifest> | null | undefined;
  if (!candidate || typeof candidate !== "object") {
    return { installable: false, warnings: ["Plugin manifest must be an object."], requiredApprovals };
  }
  if (typeof candidate.id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(candidate.id)) warnings.push("Plugin ID is missing or malformed.");
  if (typeof candidate.version !== "string" || !candidate.version.trim() || typeof candidate.publisher !== "string" || !candidate.publisher.trim()) warnings.push("Version and publisher must be declared.");
  if (typeof candidate.description !== "string" || !candidate.description.trim()) warnings.push("Plugin description must be declared.");
  if (candidate.verified !== true) warnings.push("Publisher or package integrity has not been verified.");

  const allowed = new Set<PluginManifest["permissions"][number]>(["read-files", "write-files", "run-commands", "network", "models"]);
  if (!Array.isArray(candidate.permissions)) {
    warnings.push("Plugin permissions must be declared as an array.");
  } else {
    for (const permission of new Set(candidate.permissions as string[])) {
      if (!allowed.has(permission as PluginManifest["permissions"][number])) {
        warnings.push("Plugin requests an unknown capability: " + String(permission) + ".");
        continue;
      }
      if (permission === "write-files" || permission === "run-commands" || permission === "network") requiredApprovals.push(permission);
    }
  }
  if (candidate.sourceUrl) {
    try {
      const url = new URL(candidate.sourceUrl);
      if (url.protocol !== "https:") warnings.push("Plugin source must use HTTPS.");
      if (url.username || url.password) warnings.push("Plugin source URL must not embed credentials.");
    } catch {
      warnings.push("Plugin source URL is malformed.");
    }
  }
  return { installable: warnings.length === 0, warnings, requiredApprovals };
}
