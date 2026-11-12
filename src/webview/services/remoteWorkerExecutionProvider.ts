import type { WorkerExecutionProvider, WorkerExecutionRequest, WorkerExecutionResult } from "../../shared/workerExecution";

export interface RemoteWorkerHostJob {
  id: string;
  status: "queued" | "provisioning" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted";
  taskId: string;
  title: string;
  workspacePath?: string | null;
  summary?: string | null;
  error?: string | null;
  logs: Array<{ id: string; message: string }>;
}
export interface RemoteWorkerHostTransport {
  submit(input: {
    idempotencyKey: string;
    taskId: string;
    title: string;
    prompt: string;
    repositoryUrl: string;
    branch: string;
    agent?: string;
  }): Promise<RemoteWorkerHostJob>;
  get(jobId: string): Promise<RemoteWorkerHostJob>;
  cancel(jobId: string): Promise<void>;
}
export interface RemoteWorkerExecutionProviderOptions {
  transport: RemoteWorkerHostTransport;
  repositoryUrl: string;
  branch: string;
  pollIntervalMs?: number;
  createIdempotencyKey?: (request: WorkerExecutionRequest) => string;
}
const TERMINAL = new Set(["succeeded", "failed", "cancelled", "interrupted"]);
const WORKSPACE_TOKEN = "__AXIOM_WORKSPACE_ROOT__";

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("Remote worker polling cancelled."));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Remote worker polling cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Executes tasks on an authenticated Worker Host through an injected main-process transport. */
export function createRemoteWorkerExecutionProvider(options: RemoteWorkerExecutionProviderOptions): WorkerExecutionProvider {
  if (!options.transport || typeof options.transport.submit !== "function"
    || typeof options.transport.get !== "function" || typeof options.transport.cancel !== "function") {
    throw new TypeError("A complete remote worker host transport is required.");
  }
  if (typeof options.repositoryUrl !== "string" || !options.repositoryUrl.trim()
    || typeof options.branch !== "string" || !options.branch.trim()) {
    throw new TypeError("A repository URL and target branch are required for remote execution.");
  }
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs! >= 100
    ? Math.min(options.pollIntervalMs!, 10_000) : 1000;
  return {
    id: "remote",
    capabilities: { isolatedWorkspaces: true, cancellation: "confirmed", streamingLogs: true },
    async execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult> {
      if (request.signal?.aborted) throw new Error("Remote worker cancelled before submission.");
      const idempotencyKey = options.createIdempotencyKey?.(request)
        ?? globalThis.crypto.randomUUID();
      const job = await options.transport.submit({
        idempotencyKey,
        taskId: request.task.id,
        title: request.task.title,
        prompt: request.buildPrompt(WORKSPACE_TOKEN),
        repositoryUrl: options.repositoryUrl,
        branch: options.branch,
        ...(request.agent ? { agent: request.agent } : {}),
      });
      if (!job?.id || job.taskId !== request.task.id) {
        throw new Error("Remote Worker Host returned an invalid job identity.");
      }
      const seenLogs = new Set<string>();
      let cancelRequested = false;
      let current = job;
      while (!TERMINAL.has(current.status)) {
        for (const entry of current.logs || []) {
          if (typeof entry.id !== "string" || seenLogs.has(entry.id)) continue;
          seenLogs.add(entry.id);
          try { request.onLog?.(request.task.id, entry.message); } catch { /* log observers are isolated */ }
        }
        if (request.signal?.aborted && !cancelRequested) {
          cancelRequested = true;
          try { await options.transport.cancel(job.id); } catch { /* Keep polling; an unconfirmed cancellation must remain quarantined. */ }
        }
        await delay(pollIntervalMs);
        try { current = await options.transport.get(job.id); } catch (error) {\n          if (!request.signal?.aborted) throw error;\n          continue;\n        }
      }
      for (const entry of current.logs || []) {
        if (typeof entry.id !== "string" || seenLogs.has(entry.id)) continue;
        seenLogs.add(entry.id);
        try { request.onLog?.(request.task.id, entry.message); } catch { /* log observers are isolated */ }
      }
      if (current.status === "cancelled" || current.status === "interrupted") {
        throw Object.assign(new Error(current.error || "Remote worker did not complete."), {
          name: current.status === "cancelled" ? "AbortError" : "RemoteWorkerInterruptedError",
          sessionId: "remote:" + job.id,
          worktreePath: current.workspacePath || undefined,
        });
      }
      if (current.status !== "succeeded") {
        throw Object.assign(new Error(current.error || "Remote worker execution failed."), {
          sessionId: "remote:" + job.id,
          worktreePath: current.workspacePath || undefined,
        });
      }
      if (!current.workspacePath) throw new Error("Remote Worker Host completed without returning its workspace path.");
      return {
        sessionId: "remote:" + job.id,
        taskId: request.task.id,
        title: request.task.title,
        ...(request.agent ? { agent: request.agent } : {}),
        summary: current.summary || "Remote execution completed.",
        worktreePath: current.workspacePath,
        logs: current.logs.map(entry => entry.message).slice(-200),
      };
    },
  };
}
