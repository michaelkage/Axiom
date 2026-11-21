import { describe, expect, it, vi } from "vitest";
import type { WorkerExecutionRequest } from "../../shared/workerExecution";
import { createRemoteWorkerExecutionProvider, type RemoteWorkerHostJob, type RemoteWorkerHostTransport } from "./remoteWorkerExecutionProvider";

function request(signal?: AbortSignal): WorkerExecutionRequest {
  return {
    task: { id: "task-1", title: "Implement endpoint", scope: "Implement endpoint", targetFiles: ["src/api.ts"], dependsOn: [] },
    parentSessionId: "parent-1",
    workspaceRoot: "/local/project",
    buildPrompt: path => "Implement endpoint in " + path,
    agent: "implementation",
    signal,
    onLog: vi.fn(),
  };
}
function job(overrides: Partial<RemoteWorkerHostJob> = {}): RemoteWorkerHostJob {
  return { id: "remote-job-1", status: "succeeded", taskId: "task-1", title: "Implement endpoint",
    workspacePath: "/srv/axiom/workspaces/job-1", summary: "Implemented remotely.", patchAvailable: true,
    logs: [{ id: "log-1", message: "worker started" }], ...overrides };
}
function transport(overrides: Partial<RemoteWorkerHostTransport> = {}): RemoteWorkerHostTransport {
  return {
    submit: vi.fn(async () => job({ status: "running", logs: [] })),
    get: vi.fn(async () => job()),
    cancel: vi.fn(async () => undefined),
    getPatch: vi.fn(async () => ({ patch: "diff --git a/src/api.ts b/src/api.ts\\n--- a/src/api.ts\\n+++ b/src/api.ts\\n@@ -1 +1 @@\\n-old\\n+new\\n", bytes: 80 })),
    ...overrides,
  };
}
describe("remote worker execution provider", () => {
  it("submits a prompt template and maps a completed remote job", async () => {
    const host = transport();
    const applyPatch = vi.fn(async () => ({ worktreePath: "/local/worktrees/task-1" }));
    const provider = createRemoteWorkerExecutionProvider({ transport: host, applyPatch, repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 });
    const executionRequest = request();
    const result = await provider.execute(executionRequest);
    expect(host.submit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1", branch: "main",
      prompt: "Implement endpoint in __AXIOM_WORKSPACE_ROOT__",
    }));
    expect(result).toMatchObject({
      sessionId: "remote:remote-job-1", worktreePath: "/local/worktrees/task-1",
      summary: "Implemented remotely.", taskId: "task-1",
    });
    expect(executionRequest.onLog).toHaveBeenCalledWith("task-1", "worker started");
    expect(host.getPatch).toHaveBeenCalledWith("remote-job-1");
    expect(applyPatch).toHaveBeenCalledWith(expect.objectContaining({ jobId: "remote-job-1", taskId: "task-1" }));
  });
  it("streams each log entry once across status polls", async () => {
    const onLog = vi.fn();
    const host = transport({
      get: vi.fn(async () => job({ logs: [{ id: "log-1", message: "worker started" }, { id: "log-2", message: "worker finished" }] })),
    });
    await createRemoteWorkerExecutionProvider({ transport: host, applyPatch: async () => ({ worktreePath: "/tmp/local-review" }), repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 }).execute({ ...request(), onLog });
    expect(onLog).toHaveBeenCalledTimes(2);
  });

  it("resumes the same persisted host job after transient polling failures", async () => {
    const submit = vi.fn(async (_input: Parameters<RemoteWorkerHostTransport["submit"]>[0]) => job({ status: "running", logs: [] }));
    const host = transport({
      submit,
      get: vi.fn()
        .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
        .mockRejectedValueOnce(new Error("fetch failed: ECONNRESET"))
        .mockResolvedValue(job()),
    });
    const provider = createRemoteWorkerExecutionProvider({
      transport: host,
      applyPatch: async () => ({ worktreePath: "/tmp/local-review" }),
      repositoryUrl: "https://github.com/acme/repo.git",
      branch: "main",
      pollIntervalMs: 100,
      maxPollFailures: 2,
    });
    await expect(provider.execute(request())).rejects.toMatchObject({ name: "RemoteWorkerTransportError", remoteJobId: "remote-job-1" });
    const recovered = await provider.execute(request());
    expect(recovered.worktreePath).toBe("/tmp/local-review");
    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0][0].idempotencyKey).toBe(submit.mock.calls[1][0].idempotencyKey);
  });

  it("waits for confirmed remote cancellation before rejecting", async () => {
    const controller = new AbortController();
    let polls = 0;
    const host = transport({
      submit: vi.fn(async () => job({ status: "running", logs: [] })),
      get: vi.fn(async () => ++polls > 1 ? job({ status: "cancelled", error: "Cancellation confirmed." }) : job({ status: "running", logs: [] })),
    });
    const pending = createRemoteWorkerExecutionProvider({ transport: host, applyPatch: async () => ({ worktreePath: "/tmp/local-review" }), repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 }).execute(request(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(host.cancel).toHaveBeenCalledWith("remote-job-1");
  });

  it("quarantines a remote worker when cancellation cannot be confirmed", async () => {
    const controller = new AbortController();
    const host = transport({
      submit: vi.fn(async () => job({ status: "running", logs: [] })),
      get: vi.fn(async () => job({ status: "running", logs: [] })),
    });
    const pending = createRemoteWorkerExecutionProvider({
      transport: host,
      repositoryUrl: "https://github.com/acme/repo.git",
      branch: "main",
      applyPatch: async () => ({ worktreePath: "/tmp/local-review" }),
      pollIntervalMs: 100,
      cancellationTimeoutMs: 200,
    }).execute(request(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      name: "RemoteWorkerCancellationUnconfirmedError",
      workerAbortUnconfirmed: true,
      sessionId: "remote:remote-job-1",
    });
  });

  it("rejects interrupted hosts without retrying or claiming success", async () => {
    const host = transport({ get: vi.fn(async () => job({ status: "interrupted", error: "Host restarted." })) });
    await expect(createRemoteWorkerExecutionProvider({ transport: host, applyPatch: async () => ({ worktreePath: "/tmp/local-review" }), repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 }).execute(request()))
      .rejects.toMatchObject({ name: "RemoteWorkerInterruptedError" });
  });
});

  it("does not release a remote worker when cancellation acknowledgement is unavailable", async () => {
    const controller = new AbortController();
    let polls = 0;
    const host = transport({
      submit: vi.fn(async () => job({ status: "running", logs: [] })),
      cancel: vi.fn(async () => { throw new Error("host temporarily unavailable"); }),
      get: vi.fn(async () => ++polls > 2 ? job({ status: "cancelled" }) : job({ status: "running", logs: [] })),
    });
    const pending = createRemoteWorkerExecutionProvider({ transport: host, applyPatch: async () => ({ worktreePath: "/tmp/local-review" }), repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 }).execute(request(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(host.get).toHaveBeenCalled();
  });
