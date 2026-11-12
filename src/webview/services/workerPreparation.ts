import {
  contextForSpecialist,
  filterProjectContext,
  inferSpecialist,
  type PackedContext,
} from "../../shared/intelligence";
import type { AxiomSubTask } from "../../shared/axiomRuntime";

export interface WorkerContextRecord {
  id: string;
  content: string;
  relevance?: number;
  updatedAt?: number;
}

export interface WorkerContextInput {
  request: string;
  planSteps?: string[];
  conversation: WorkerContextRecord[];
  projectMemories: WorkerContextRecord[];
}

export interface PreparedWorkerContext {
  conversation: WorkerContextRecord[];
  projectMemories: WorkerContextRecord[];
}

export interface WorkerAgentResolution {
  agent?: string;
  roleHint: string;
}

/** Secret-screen and normalize retrieved context once before sharing it with worker prompts. */
export function prepareWorkerContext(input: WorkerContextInput): PreparedWorkerContext {
  const conversation = filterProjectContext(
    input.conversation.map(item => ({ ...item, kind: "conversation" as const, relevance: item.relevance ?? 50 })),
  ).included.map(({ id, content, relevance, updatedAt }) => ({ id, content, relevance, updatedAt }));
  const projectMemories = filterProjectContext(
    input.projectMemories.map(item => ({ ...item, kind: "decision" as const, relevance: item.relevance ?? 85 })),
  ).included.map(({ id, content, relevance, updatedAt }) => ({ id, content, relevance, updatedAt }));
  return { conversation, projectMemories };
}

/** Resolve only against agents actually advertised by the runtime. Never invent a fallback name. */
export function resolveWorkerAgent(
  task: Pick<AxiomSubTask, "title" | "scope" | "agentHint">,
  availableAgentNames: Iterable<string>,
  preferredAgent?: string | null,
): WorkerAgentResolution {
  const available = [...new Set([...availableAgentNames].filter(name => typeof name === "string" && name.length > 0))];
  const roleHint = task.agentHint ?? inferSpecialist(task.title + "\n" + task.scope);
  if (task.agentHint && available.includes(task.agentHint)) return { agent: task.agentHint, roleHint };
  const matchingSpecialist = available.find(name => name.toLowerCase().includes(roleHint.toLowerCase()));
  if (matchingSpecialist) return { agent: matchingSpecialist, roleHint };
  if (preferredAgent && available.includes(preferredAgent)) return { agent: preferredAgent, roleHint };
  return { roleHint };
}

export function prepareWorkerTask(input: {
  task: AxiomSubTask;
  request: string;
  planSteps?: string[];
  conversation: WorkerContextRecord[];
  projectMemories: WorkerContextRecord[];
  completedTasks: Array<{ title: string; summary?: string }>;
}): { packed: PackedContext; buildPrompt: (worktreePath: string) => string } {
  const safeContext = prepareWorkerContext(input);
  const packed = contextForSpecialist({
    request: input.request || input.task.scope,
    taskTitle: input.task.title,
    taskScope: input.task.scope,
    targetFiles: input.task.targetFiles,
    planSteps: input.planSteps,
    conversation: safeContext.conversation,
    projectMemories: safeContext.projectMemories,
    completedTasks: input.completedTasks.map(task => ({
      title: task.title,
      status: "succeeded",
      summary: task.summary,
    })),
    constraints: [
      "Do not overlap with sibling tasks. Preserve unrelated behavior.",
      "Run focused checks where available and report exact commands and observed outcomes.",
    ],
  });

  const buildPrompt = (worktreePath: string) => [
    "Axiom parallel task: " + input.task.title,
    "Task scope: " + input.task.scope,
    "Declared target files: " + (input.task.targetFiles.length ? input.task.targetFiles.join(", ") : "(none declared; keep the scope narrow)"),
    "Acceptance criteria (each must be addressed and evidenced): " + (
      input.task.acceptanceCriteria?.length
        ? input.task.acceptanceCriteria.map((criterion, index) => (index + 1) + ". " + criterion).join("; ")
        : "Implement the declared scope and report concrete verification evidence."
    ),
    "Isolated worktree path: " + worktreePath,
    "Context budget: approximately " + packed.inputEstimatedTokens + " tokens before packing and " +
      packed.estimatedTokens + " after packing; estimated savings " + packed.estimatedSavingsTokens +
      " tokens (" + packed.estimatedSavingsPercent + "%). These are heuristic estimates, not provider-reported usage.",
    ...packed.items.map(item => "[" + item.kind + "] " + item.content),
    "This task runs in an isolated Git worktree created from repository HEAD. Do not assume uncommitted parent-workspace edits are present. Report the worktree path and changed files for explicit integration review.",
    "Follow the task scope and declared target-file restrictions. Treat context as guidance, not permission to exceed scope.",
  ].join("\n\n");

  return { packed, buildPrompt };
}
