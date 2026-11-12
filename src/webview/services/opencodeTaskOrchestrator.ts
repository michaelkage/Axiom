import {
  executeTaskBatches,
  type AxiomSubTask,
  type TaskExecutionRecord,
} from "../../shared/axiomRuntime";
import {
  retrieveProjectMemories,
  type ProjectMemory,
} from "../../shared/axiomWorkflow";
import { isProjectMemoryStale, loadProjectMemories } from "../utils/projectMemory";
import {
  prepareWorkerTask,
  resolveWorkerAgent,
  type WorkerContextRecord,
} from "./workerPreparation";
import {
  runOpenCodeWorkerLifecycle,
  type OpenCodeWorkerLifecycleOptions,
} from "./opencodeWorkerLifecycle";

export interface OpenCodeTaskOrchestratorOptions {
  parentSessionId: string;
  tasks: AxiomSubTask[];
  workspaceRoot?: string;
  preferredAgent?: string | null;
  request: string;
  planSteps?: string[];
  signal?: AbortSignal;
  onOutcome?: (record: TaskExecutionRecord) => void;
  onLog?: (taskId: string, line: string) => void;
  loadConversation: () => Promise<WorkerContextRecord[]>;
  loadProjectMemories: (request: string) => WorkerContextRecord[];
  loadAvailableAgents: () => Promise<string[]>;
  createWorktree: OpenCodeWorkerLifecycleOptions["createWorktree"];
  createSession: OpenCodeWorkerLifecycleOptions["createSession"];
  promptSession: OpenCodeWorkerLifecycleOptions["promptSession"];
  abortSession: OpenCodeWorkerLifecycleOptions["abortSession"];
  getMessages: OpenCodeWorkerLifecycleOptions["getMessages"];
  subscribe: OpenCodeWorkerLifecycleOptions["subscribe"];
}

/**
 * Coordinates context acquisition, specialist selection and bounded worker execution.
 * Provider-specific SDK calls remain injected at the boundary.
 */
export async function runOpenCodeSubAgentTasks(
  options: OpenCodeTaskOrchestratorOptions,
) {
  const directory = options.workspaceRoot;
  if (!directory) throw new Error("Cannot isolate agent task without a workspace root.");
  if (options.signal?.aborted) throw new Error("Parallel task cancelled before worker preparation.");

  const [conversation, projectMemories, availableAgentNames] = await Promise.all([
    options.loadConversation().catch(() => []),
    Promise.resolve().then(() => options.loadProjectMemories(options.request)).catch(() => []),
    options.loadAvailableAgents().catch(() => []),
  ]);

  if (options.signal?.aborted) throw new Error("Parallel task cancelled before worker execution.");

  return executeTaskBatches(options.tasks, async (task, completed, signal) => {
    if (signal?.aborted) throw new Error("Parallel task cancelled before worker startup.");

    const prepared = prepareWorkerTask({
      task,
      request: options.request || task.scope,
      planSteps: options.planSteps,
      conversation,
      projectMemories,
      completedTasks: completed.map(entry => ({
        title: entry.task.title,
        summary: typeof entry.result === "object" && entry.result !== null && "summary" in entry.result
          ? String((entry.result as { summary: unknown }).summary)
          : undefined,
      })),
    });
    const { packed, buildPrompt } = prepared;
    const { agent } = resolveWorkerAgent(task, availableAgentNames, options.preferredAgent);

    const worker = await runOpenCodeWorkerLifecycle({
      task,
      parentSessionId: options.parentSessionId,
      workspaceRoot: directory,
      buildPrompt,
      agent,
      diagnostics: {
        contextEstimatedTokensBefore: packed.inputEstimatedTokens,
        contextEstimatedTokensAfter: packed.estimatedTokens,
        contextSavingsPercent: packed.estimatedSavingsPercent,
      },
      signal,
      createWorktree: options.createWorktree,
      createSession: options.createSession,
      promptSession: options.promptSession,
      abortSession: options.abortSession,
      getMessages: options.getMessages,
      subscribe: options.subscribe,
      onLog: options.onLog,
    });

    return {
      ...worker,
      contextEstimatedTokensBefore: packed.inputEstimatedTokens,
      contextEstimatedTokensAfter: packed.estimatedTokens,
      contextSavingsPercent: packed.estimatedSavingsPercent,
    };
  }, options.onOutcome, { signal: options.signal, timeoutMs: 120_000 });
}

/** Build a secret-screened project-memory snapshot for one orchestration request. */
export function loadRelevantWorkerProjectMemories(
  workspaceRoot: string | undefined,
  request: string,
): WorkerContextRecord[] {
  try {
    const memories = loadProjectMemories(workspaceRoot) as ProjectMemory[];
    return retrieveProjectMemories(memories, request, 8)
      .filter(memory => !isProjectMemoryStale(memory))
      .map(memory => ({
        id: memory.id,
        content: "[" + memory.category + (memory.tags.length ? "; " + memory.tags.join(", ") : "") + "] " + memory.content,
        kind: "decision" as const,
        relevance: 85,
        updatedAt: Date.parse(memory.updatedAt),
      }));
  } catch {
    return [];
  }
}
