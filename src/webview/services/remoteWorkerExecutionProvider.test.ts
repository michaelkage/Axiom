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
    workspacePath: "/srv/axiom/workspaces/job-1", summary: "Implemented remotely.",
    logs: [{ id: "log-1", message: "worker started" }], ...overrides };
}
function transport(overrides: Partial<RemoteWorkerHostTransport> = {}): RemoteWorkerHostTransport {
  return {
    submit: vi.fn(async () => job({ status: "running", logs: [] })),
    get: vi.fn(async () => job()),
    cancel: vi.fn(async () => undefined),
    ...overrides,
  };
}
describe("remote worker execution provider", () => {
  it("submits a prompt template and maps a completed remote job", async () => {
    const host = transport();
    const provider = createRemoteWorkerExecutionProvider({ transport: host, repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 });
    const result = await provider.execute(request());
    expect(host.submit).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1", branch: "main",
      prompt: "Implement endpoint in __AXIOM_WORKSPACE_ROOT__",
    }));
    expect(result).toMatchObject({
      sessionId: "remote:remote-job-1", worktreePath: "/srv/axiom/workspaces/job-1",
      summary: "Implemented remotely.", taskId: "task-1",
    });
    expect(request().onLog).not.toHaveBeenCalled();
  });
  it("streams each log entry once across status polls", async () => {
    const onLog = vi.fn();
    const host = transport({
      get: vi.fn(async () => job({ logs: [{ id: "log-1", message: "worker started" }, { id: "log-2", message: "worker finished" }] })),
    });
    await createRemoteWorkerExecutionProvider({ transport: host, repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 }).execute({ ...request(), onLog });
    expect(onLog).toHaveBeenCalledTimes(2);
  });
  it("waits for confirmed remote cancellation before rejecting", async () => {
    const controller = new AbortController();
    let polls = 0;
    const host = transport({
      submit: vi.fn(async () => job({ status: "running", logs: [] })),
      get: vi.fn(async () => ++polls > 1 ? job({ status: "cancelled", error: "Cancellation confirmed." }) : job({ status: "running", logs: [] })),
    });
    const pending = createRemoteWorkerExecutionProvider({ transport: host, repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 }).execute(request(controller.signal));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(host.cancel).toHaveBeenCalledWith("remote-job-1");
  });
  it("rejects interrupted hosts without retrying or claiming success", async () => {
    const host = transport({ get: vi.fn(async () => job({ status: "interrupted", error: "Host restarted." })) });
    await expect(createRemoteWorkerExecutionProvider({ transport: host, repositoryUrl: "https://github.com/acme/repo.git", branch: "main", pollIntervalMs: 100 }).execute(request()))
      .rejects.toMatchObject({ name: "RemoteWorkerInterruptedError" });
  });
});
