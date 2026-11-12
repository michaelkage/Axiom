import type { WorkerExecutionProvider, WorkerExecutionRequest, WorkerExecutionResult } from "../../shared/workerExecution";
import {
  runOpenCodeWorkerLifecycle,
  type OpenCodeWorkerLifecycleOptions,
} from "./opencodeWorkerLifecycle";

export type OpenCodeWorkerExecutionDependencies = Omit<
  OpenCodeWorkerLifecycleOptions,
  "task" | "parentSessionId" | "workspaceRoot" | "buildPrompt" | "agent" | "diagnostics" | "signal" | "onLog"
>;

/** Adapts the OpenCode SDK lifecycle to Axiom's provider-neutral worker contract. */
export function createOpenCodeWorkerExecutionProvider(
  dependencies: OpenCodeWorkerExecutionDependencies,
): WorkerExecutionProvider {
  return {
    id: "opencode",
    async execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult> {
      return runOpenCodeWorkerLifecycle({
        ...dependencies,
        task: request.task,
        parentSessionId: request.parentSessionId,
        workspaceRoot: request.workspaceRoot,
        buildPrompt: request.buildPrompt,
        ...(request.agent ? { agent: request.agent } : {}),
        diagnostics: request.diagnostics,
        signal: request.signal,
        onLog: request.onLog,
      });
    },
  };
}
