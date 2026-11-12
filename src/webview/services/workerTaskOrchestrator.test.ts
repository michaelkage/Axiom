import { describe, expect, it, vi } from "vitest";
import type { AxiomSubTask, TaskExecutionRecord } from "../../shared/axiomRuntime";
import type { TaskOrchestratorOptions } from "./workerTaskOrchestrator";
import { runSubAgentTasks } from "./workerTaskOrchestrator";
import { createOpenCodeWorkerExecutionProvider } from "./opencodeWorkerExecutionProvider";

const task: AxiomSubTask = {
  id: "api-tests",
  title: "Add API tests",
  scope: "Add focused API client tests.",
  targetFiles: ["src/api.test.ts"],
  dependsOn: [],
  acceptanceCriteria: ["Cover successful and failed requests."],
};

function setup(overrides: Partial<TaskOrchestratorOptions> = {}) {
  const outcomes: TaskExecutionRecord[] = [];
  const calls = {
    loadConversation: vi.fn(async () => [{ id: "history-1", content: "Use the shared fetch wrapper.", relevance: 80 }]),
    loadProjectMemories: vi.fn(() => [{ id: "memory-1", content: "Use Vitest for unit tests.", relevance: 90 }]),
    loadAvailableAgents: vi.fn(async () => ["implementation", "testing"]),
    createWorktree: vi.fn(async () => "/tmp/axiom-worker"),
    createSession: vi.fn(async () => ({ data: { id: "child-session" } })),
    promptSession: vi.fn(async () => ({})),
    abortSession: vi.fn(async () => ({})),
    getMessages: vi.fn(async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Tests implemented." }] }],
    })),
    subscribe: vi.fn(() => () => undefined),
  };
  const options: TaskOrchestratorOptions = {
    ...overrides,
    parentSessionId: "parent-session",
    tasks: [task],
    workspaceRoot: "/workspace/project",
    preferredAgent: "implementation",
    request: "Improve API reliability",
    planSteps: ["Inspect the current API client."],
    onOutcome: (record: TaskExecutionRecord) => outcomes.push(record),
    workerProvider: createOpenCodeWorkerExecutionProvider({
      createWorktree: calls.createWorktree,
      createSession: calls.createSession,
      promptSession: calls.promptSession,
      abortSession: calls.abortSession,
      getMessages: calls.getMessages,
      subscribe: calls.subscribe,
    }),
    onLog: overrides.onLog,
  };
  return { options, calls, outcomes };
}

describe("runSubAgentTasks", () => {
  it("rejects a missing workspace before loading context or starting workers", async () => {
    const { options, calls } = setup({ workspaceRoot: undefined });
    await expect(runSubAgentTasks(options)).rejects.toThrow(/workspace root/i);
    expect(calls.loadConversation).not.toHaveBeenCalled();
    expect(calls.createWorktree).not.toHaveBeenCalled();
  });

  it("prepares context, selects an advertised specialist, and executes an isolated worker", async () => {
    const { options, calls, outcomes } = setup();
    const results = await runSubAgentTasks(options);

    expect(calls.loadConversation).toHaveBeenCalledTimes(1);
    expect(calls.loadProjectMemories).toHaveBeenCalledWith("Improve API reliability");
    expect(calls.loadAvailableAgents).toHaveBeenCalledTimes(1);
    expect(calls.createSession).toHaveBeenCalledWith({
      directory: "/tmp/axiom-worker",
      parentID: "parent-session",
      title: "Axiom: Add API tests",
    });
    expect(calls.promptSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionID: "child-session",
      agent: "testing",
    }));
    expect(calls.promptSession).toHaveBeenCalledWith(expect.objectContaining({
      parts: [expect.objectContaining({ text: expect.stringContaining("Use the shared fetch wrapper.") })],
    }));
    expect(calls.promptSession).toHaveBeenCalledWith(expect.objectContaining({
      parts: [expect.objectContaining({ text: expect.stringContaining("Use Vitest for unit tests.") })],
    }));
    expect(calls.promptSession).toHaveBeenCalledWith(expect.objectContaining({
      parts: [expect.objectContaining({ text: expect.stringContaining("Isolated worktree path: /tmp/axiom-worker") })],
    }));
    expect(results).toHaveLength(1);
    expect(results[0].result).toMatchObject({
      sessionId: "child-session",
      worktreePath: "/tmp/axiom-worker",
      contextEstimatedTokensBefore: expect.any(Number),
      contextEstimatedTokensAfter: expect.any(Number),
    });
    expect(outcomes.some(record => record.status === "succeeded")).toBe(true);
  });

  it("continues without optional history, memory, or agent catalogues when providers fail", async () => {
    const { options, calls } = setup({
      loadConversation: vi.fn(async () => { throw new Error("history unavailable"); }),
      loadProjectMemories: vi.fn(() => { throw new Error("memory store unavailable"); }),
      loadAvailableAgents: vi.fn(async () => { throw new Error("agent catalogue unavailable"); }),
    });
    const results = await runSubAgentTasks(options);

    expect(results).toHaveLength(1);
    expect(calls.promptSession).toHaveBeenCalledWith(expect.objectContaining({ sessionID: "child-session" }));
    expect(calls.promptSession).toHaveBeenCalledWith(expect.not.objectContaining({ agent: expect.anything() }));
  });

  it("executes through an injected provider without requiring OpenCode SDK methods", async () => {
    const execute = vi.fn(async request => ({
      sessionId: "remote-session",
      taskId: request.task.id,
      title: request.task.title,
      summary: "Executed by an independent provider.",
      worktreePath: "/remote/workspaces/api-tests",
      logs: ["remote worker accepted task"],
    }));
    const { options, calls } = setup({
      workerProvider: {
        id: "remote-test",
        capabilities: { isolatedWorkspaces: true, cancellation: "confirmed", streamingLogs: true },
        execute,
      },
    });

    const results = await runSubAgentTasks(options);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toMatchObject({
      task: { id: "api-tests" },
      parentSessionId: "parent-session",
      workspaceRoot: "/workspace/project",
      agent: "testing",
    });
    expect(results[0].result).toMatchObject({
      sessionId: "remote-session",
      worktreePath: "/remote/workspaces/api-tests",
      summary: "Executed by an independent provider.",
    });
    expect(calls.createSession).not.toHaveBeenCalled();
  });

  it("does not begin context acquisition when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { options, calls } = setup({ signal: controller.signal });
    await expect(runSubAgentTasks(options)).rejects.toThrow(/cancelled/i);
    expect(calls.loadConversation).not.toHaveBeenCalled();
    expect(calls.createWorktree).not.toHaveBeenCalled();
  });
});
