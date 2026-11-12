import type { AxiomSubTask } from "./axiomRuntime";

/** Provider-neutral input for one isolated worker execution. */
export interface WorkerExecutionRequest {
  task: AxiomSubTask;
  parentSessionId: string;
  workspaceRoot: string;
  buildPrompt: (workingDirectory: string) => string;
  agent?: string;
  diagnostics?: Record<string, number>;
  signal?: AbortSignal;
  onLog?: (taskId: string, line: string) => void;
}

/** Stable result shape consumed by orchestration, supervision and review. */
export interface WorkerExecutionResult {
  sessionId: string;
  taskId: string;
  title: string;
  agent?: string;
  summary: string;
  worktreePath: string;
  logs: string[];
}

/**
 * Implementations own provider-specific session and transport details.
 * Cancellation is cooperative: execute must not resolve until provider abort
 * handling has settled. The supervisor quarantines executions that do not drain.
 */
export interface WorkerExecutionProvider {
  readonly id: string;
  readonly capabilities: {
    isolatedWorkspaces: boolean;
    cancellation: "cooperative" | "confirmed";
    streamingLogs: boolean;
  };
  execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult>;
}
