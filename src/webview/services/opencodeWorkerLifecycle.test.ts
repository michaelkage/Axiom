import { describe, expect, it, vi } from "vitest";
import { runOpenCodeWorkerLifecycle } from "./opencodeWorkerLifecycle";

function baseOptions(overrides: Record<string, unknown> = {}) {
  const calls = {
    createWorktree: vi.fn(async () => "/tmp/axiom-worker-1"),
    createSession: vi.fn(async () => ({ data: { id: "child-session-1" } })),
    promptSession: vi.fn(async () => ({})),
    abortSession: vi.fn(async () => ({})),
    getMessages: vi.fn(async () => ({
      data: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "Implemented and verified." }] }],
    })),
    subscribe: vi.fn(() => () => undefined),
    onLog: vi.fn(),
  };
  const options = {
    task: { id: "worker-1", title: "Implement worker feature" },
    parentSessionId: "parent-session",
    workspaceRoot: "/workspace/project",
    buildPrompt: (worktreePath: string) => "Work in " + worktreePath,
    createWorktree: calls.createWorktree,
    createSession: calls.createSession,
    promptSession: calls.promptSession,
    abortSession: calls.abortSession,
    getMessages: calls.getMessages,
    subscribe: calls.subscribe,
    onLog: calls.onLog,
    now: () => new Date("2026-11-12T12:00:00.000Z"),
    ...overrides,
  };
  return { options, calls };
}

describe("runOpenCodeWorkerLifecycle", () => {
  it("creates an isolated session, prompts with its real worktree path, and returns transcript diagnostics", async () => {
    const { options, calls } = baseOptions();
    const result = await runOpenCodeWorkerLifecycle(options);

    expect(calls.createWorktree).toHaveBeenCalledWith("worker-1", "/workspace/project");
    expect(calls.createSession).toHaveBeenCalledWith({
      directory: "/tmp/axiom-worker-1",
      parentID: "parent-session",
      title: "Axiom: Implement worker feature",
    });
    expect(calls.promptSession).toHaveBeenCalledWith({
      sessionID: "child-session-1",
      parts: [{ type: "text", text: "Work in /tmp/axiom-worker-1" }],
    });
    expect(result).toMatchObject({
      sessionId: "child-session-1",
      taskId: "worker-1",
      title: "Implement worker feature",
      summary: "Implemented and verified.",
      worktreePath: "/tmp/axiom-worker-1",
    });
    expect(result.logs.some(line => line.includes("Assistant transcript: Implemented and verified."))).toBe(true);
  });

  it("preserves the worktree path when child-session creation fails", async () => {
    const { options, calls } = baseOptions({
      createSession: vi.fn(async () => { throw new Error("runtime unavailable"); }),
    });

    await expect(runOpenCodeWorkerLifecycle(options)).rejects.toMatchObject({
      message: expect.stringContaining("runtime unavailable"),
      worktreePath: "/tmp/axiom-worker-1",
    });
    expect(calls.promptSession).not.toHaveBeenCalled();
  });

  it("aborts the child session and removes lifecycle listeners when cancellation occurs during prompting", async () => {
    const controller = new AbortController();
    const stopEvents = vi.fn();
    const abortSession = vi.fn(async () => ({}));
    const promptSession = vi.fn(async () => {
      controller.abort();
      return {};
    });
    const { options } = baseOptions({
      signal: controller.signal,
      abortSession,
      promptSession,
      subscribe: vi.fn(() => stopEvents),
    });

    await expect(runOpenCodeWorkerLifecycle(options)).rejects.toMatchObject({
      message: expect.stringContaining("cancelled"),
      sessionId: "child-session-1",
      worktreePath: "/tmp/axiom-worker-1",
    });
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(stopEvents).toHaveBeenCalledTimes(1);
  });

  it("bounds retained logs and continues when transcript retrieval fails", async () => {
    const { options, calls } = baseOptions({
      getMessages: vi.fn(async () => { throw new Error("transcript unavailable"); }),
      subscribe: (onEvent: (event: unknown) => void) => {
        for (let index = 0; index < 205; index += 1) {
          onEvent({ type: "tool.updated", sessionID: "child-session-1", index });
        }
        return () => undefined;
      },
    });

    const result = await runOpenCodeWorkerLifecycle(options);
    expect(result.summary).toContain("Agent prompt was accepted");
    expect(result.logs.length).toBeLessThanOrEqual(200);
    expect(calls.onLog).toHaveBeenCalled();
  });

  it("does not create a worktree when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { options, calls } = baseOptions({ signal: controller.signal });

    await expect(runOpenCodeWorkerLifecycle(options)).rejects.toThrow(/cancelled/i);
    expect(calls.createWorktree).not.toHaveBeenCalled();
  });
});
