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
  patchAvailable?: boolean;
  patchError?: string | null;
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
  getPatch(jobId: string): Promise<{ patch: string; bytes: number }>;
}
export interface RemoteWorkerExecutionProviderOptions {
  transport: RemoteWorkerHostTransport;
  repositoryUrl: string;
  branch: string;
  pollIntervalMs?: number;
  createIdempotencyKey?: (request: WorkerExecutionRequest) => string;
  maxExecutionMs?: number;
  cancellationTimeoutMs?: number;
  maxPollFailures?: number;
  now?: () => number;
  applyPatch: (input: { jobId: string; taskId: string; title: string; patch: string }) => Promise<{ worktreePath: string }>;
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
    || typeof options.transport.get !== "function" || typeof options.transport.cancel !== "function"
    || typeof options.transport.getPatch !== "function" || typeof options.applyPatch !== "function") {
    throw new TypeError("A complete remote worker host transport is required.");
  }
  if (typeof options.repositoryUrl !== "string" || !options.repositoryUrl.trim()
    || typeof options.branch !== "string" || !options.branch.trim()) {
    throw new TypeError("A repository URL and target branch are required for remote execution.");
  }
  const pollIntervalMs = Number.isInteger(options.pollIntervalMs) && options.pollIntervalMs! >= 100
    ? Math.min(options.pollIntervalMs!, 10_000) : 1000;
  const maxExecutionMs = Number.isFinite(options.maxExecutionMs) && (options.maxExecutionMs ?? 0) >= 1000
    ? Math.min(options.maxExecutionMs!, 24 * 60 * 60 * 1000) : 60 * 60 * 1000;
  const cancellationTimeoutMs = Number.isFinite(options.cancellationTimeoutMs) && (options.cancellationTimeoutMs ?? 0) >= 100
    ? Math.min(options.cancellationTimeoutMs!, 5 * 60 * 1000) : 30_000;
  const maxPollFailures = Number.isInteger(options.maxPollFailures) && (options.maxPollFailures ?? 0) > 0
    ? Math.min(options.maxPollFailures!, 10) : 5;
  const now = options.now ?? Date.now;
  const idempotencyKeys = new Map<string, string>();
  return {
    id: "remote",
    capabilities: { isolatedWorkspaces: true, cancellation: "confirmed", streamingLogs: true },
    async execute(request: WorkerExecutionRequest): Promise<WorkerExecutionResult> {
      if (request.signal?.aborted) throw new Error("Remote worker cancelled before submission.");
      const identity = request.parentSessionId + ":" + request.task.id;
      let idempotencyKey = options.createIdempotencyKey?.(request);
      if (!idempotencyKey) {
        idempotencyKey = idempotencyKeys.get(identity) ?? globalThis.crypto.randomUUID();
        idempotencyKeys.set(identity, idempotencyKey);
      }
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
      let cancellationRequestedAt: number | null = null;
      let timedOut = false;
      const startedAt = now();
      let current = job;
      let pollFailures = 0;
      while (!TERMINAL.has(current.status)) {
        for (const entry of current.logs || []) {
          if (typeof entry.id !== "string" || seenLogs.has(entry.id)) continue;
          seenLogs.add(entry.id);
          try { request.onLog?.(request.task.id, entry.message); } catch { /* log observers are isolated */ }
        }
        if (!cancelRequested && (request.signal?.aborted || now() - startedAt >= maxExecutionMs)) {
          cancelRequested = true;
          timedOut = !request.signal?.aborted;
          cancellationRequestedAt = now();
          try { void options.transport.cancel(job.id).catch(() => undefined); } catch { /* Keep polling; an unconfirmed cancellation must remain quarantined. */ }
        }
        if (cancelRequested && cancellationRequestedAt !== null && now() - cancellationRequestedAt >= cancellationTimeoutMs) {
          throw Object.assign(new Error("Remote worker cancellation could not be confirmed before the quarantine deadline."), {
            name: "RemoteWorkerCancellationUnconfirmedError",
            workerAbortUnconfirmed: true,
            sessionId: "remote:" + job.id,
            remoteWorkspacePath: current.workspacePath || job.workspacePath || undefined,
          });
        }
        await delay(pollIntervalMs);
        try {
          current = await options.transport.get(job.id);
          pollFailures = 0;
        } catch (error) {
          if (request.signal?.aborted) continue;
          pollFailures++;
          if (pollFailures >= maxPollFailures) {
            throw Object.assign(new Error("Remote Worker Host could not be reached after " + pollFailures + " polling attempts. The job remains saved on the host. " + String(error instanceof Error ? error.message : error).slice(0, 500)), {
              name: "RemoteWorkerTransportError", sessionId: "remote:" + job.id, remoteJobId: job.id,
            });
          }
          await delay(Math.min(pollIntervalMs * (2 ** (pollFailures - 1)), 10_000));
          continue;
        }
      }
      for (const entry of current.logs || []) {
        if (typeof entry.id !== "string" || seenLogs.has(entry.id)) continue;
        seenLogs.add(entry.id);
        try { request.onLog?.(request.task.id, entry.message); } catch { /* log observers are isolated */ }
      }
      if (timedOut && current.status === "cancelled") {
        throw Object.assign(new Error("Remote worker timed out after " + maxExecutionMs + "ms; cancellation was confirmed."), {
          name: "RemoteWorkerTimeoutError", sessionId: "remote:" + job.id,
          remoteWorkspacePath: current.workspacePath || job.workspacePath || undefined,
        });
      }
      if (current.status === "cancelled" || current.status === "interrupted") {
        throw Object.assign(new Error(current.error || "Remote worker did not complete."), {
          name: current.status === "cancelled" ? "AbortError" : "RemoteWorkerInterruptedError",
          sessionId: "remote:" + job.id,
          remoteWorkspacePath: current.workspacePath || undefined,
        });
      }
      if (current.status !== "succeeded") {
        throw Object.assign(new Error(current.error || "Remote worker execution failed."), {
          sessionId: "remote:" + job.id,
          worktreePath: current.workspacePath || undefined,
        });
      }
      if (!current.patchAvailable) throw new Error(current.patchError || "Remote Worker Host completed without a transferable source patch.");
      const transferred = await options.transport.getPatch(job.id);
      if (typeof transferred?.patch !== "string" || !transferred.patch.length || transferred.patch.length > 8 * 1024 * 1024) {
        throw new Error("Remote Worker Host returned an empty or oversized source patch.");
      }
      const localWorktree = await options.applyPatch({ jobId: job.id, taskId: request.task.id, title: request.task.title, patch: transferred.patch });
      if (!localWorktree?.worktreePath || typeof localWorktree.worktreePath !== "string") {
        throw new Error("Axiom could not materialize the remote changes in a local review worktree.");
      }
      return {
        sessionId: "remote:" + job.id,
        taskId: request.task.id,
        title: request.task.title,
        ...(request.agent ? { agent: request.agent } : {}),
        summary: current.summary || "Remote execution completed.",
        worktreePath: localWorktree.worktreePath,
        logs: current.logs.map(entry => entry.message).slice(-200),
      };
    },
  };
}
