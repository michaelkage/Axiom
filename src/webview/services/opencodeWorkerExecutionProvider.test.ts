import { describe, expect, it, vi } from "vitest";
import type { WorkerExecutionRequest } from "../../shared/workerExecution";
import { createOpenCodeWorkerExecutionProvider } from "./opencodeWorkerExecutionProvider";

describe("OpenCode worker execution provider", () => {
  it("maps the provider-neutral request to the OpenCode lifecycle and returns stable metadata", async () => {
    const createWorktree = vi.fn(async () => "/tmp/provider-worktree");
    const createSession = vi.fn(async () => ({ data: { id: "provider-session" } }));
    const promptSession = vi.fn(async () => ({}));
    const abortSession = vi.fn(async () => ({}));
    const getMessages = vi.fn(async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Provider completed." }] }],
    }));
    const subscribe = vi.fn(() => () => undefined);
    const provider = createOpenCodeWorkerExecutionProvider({
      createWorktree, createSession, promptSession, abortSession, getMessages, subscribe,
    });
    const request: WorkerExecutionRequest = {
      task: {
        id: "provider-task",
        title: "Provider task",
        scope: "Implement the requested change",
        targetFiles: ["src/provider.ts"],
        dependsOn: [],
      },
      parentSessionId: "parent-session",
      workspaceRoot: "/workspace",
      buildPrompt: path => "Work inside " + path,
      agent: "builder",
      diagnostics: { contextEstimatedTokensBefore: 1000 },
      signal: new AbortController().signal,
    };

    const result = await provider.execute(request);

    expect(provider.id).toBe("opencode");
    expect(createWorktree).toHaveBeenCalledWith("provider-task", "/workspace");
    expect(createSession).toHaveBeenCalledWith({
      directory: "/tmp/provider-worktree",
      parentID: "parent-session",
      title: "Axiom: Provider task",
    });
    expect(promptSession).toHaveBeenCalledWith({
      sessionID: "provider-session",
      parts: [{ type: "text", text: "Work inside /tmp/provider-worktree" }],
      agent: "builder",
    });
    expect(result).toMatchObject({
      sessionId: "provider-session",
      taskId: "provider-task",
      title: "Provider task",
      worktreePath: "/tmp/provider-worktree",
      summary: "Provider completed.",
    });
  });

  it("preserves provider errors and attached lifecycle diagnostics", async () => {
    const provider = createOpenCodeWorkerExecutionProvider({
      createWorktree: async () => "/tmp/provider-worktree",
      createSession: async () => ({ data: { id: "provider-session" } }),
      promptSession: async () => { throw Object.assign(new Error("provider transport failed"), {
        sessionId: "provider-session",
        worktreePath: "/tmp/provider-worktree",
      }); },
      abortSession: async () => ({}),
      getMessages: async () => ({ data: [] }),
      subscribe: () => () => undefined,
    });

    await expect(provider.execute({
      task: { id: "failure", title: "Failure", scope: "Fail safely", targetFiles: [], dependsOn: [] },
      parentSessionId: "parent",
      workspaceRoot: "/workspace",
      buildPrompt: () => "Run",
    })).rejects.toMatchObject({
      message: "provider transport failed",
      sessionId: "provider-session",
      worktreePath: "/tmp/provider-worktree",
    });
  });
});
