import { describe, expect, it, vi } from "vitest";
import type { WorkerExecutionProvider } from "./workerExecution";
import { createWorkerExecutionProviderRegistry } from "./workerExecutionRegistry";

function provider(id: string): WorkerExecutionProvider {
  return {
    id,
    capabilities: { isolatedWorkspaces: true, cancellation: "cooperative", streamingLogs: true },
    execute: vi.fn(async request => ({
      sessionId: "session",
      taskId: request.task.id,
      title: request.task.title,
      summary: "done",
      worktreePath: "/workspace/worktree",
      logs: [],
    })),
  };
}

describe("worker execution provider registry", () => {
  it("registers providers and exposes their capabilities", () => {
    const local = provider("opencode");
    const remote = provider("remote");
    const registry = createWorkerExecutionProviderRegistry([local, remote]);

    expect(registry.get("opencode")).toBe(local);
    expect(registry.get("remote")).toBe(remote);
    expect(registry.list()).toEqual([
      { id: "opencode", capabilities: { isolatedWorkspaces: true, cancellation: "cooperative", streamingLogs: true } },
      { id: "remote", capabilities: { isolatedWorkspaces: true, cancellation: "cooperative", streamingLogs: true } },
    ]);
  });

  it("does not silently fall back when a requested provider is unavailable", () => {
    const registry = createWorkerExecutionProviderRegistry([provider("opencode")]);
    expect(() => registry.get("remote")).toThrow(/not registered: remote/);
  });

  it("rejects duplicate or malformed provider registrations", () => {
    expect(() => createWorkerExecutionProviderRegistry([provider("opencode"), provider("opencode")])).toThrow(/Duplicate/);
    expect(() => createWorkerExecutionProviderRegistry([provider("Bad ID")])).toThrow(/valid lowercase ID/);
  });

  it("rejects providers with an invalid runtime contract", () => {
    expect(() => createWorkerExecutionProviderRegistry([{
      ...provider("broken"),
      capabilities: { isolatedWorkspaces: true, cancellation: "maybe", streamingLogs: true } as never,
    }])).toThrow(/invalid capability/);
  });
});
