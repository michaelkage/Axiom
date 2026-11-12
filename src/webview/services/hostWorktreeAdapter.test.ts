import { describe, expect, it, vi } from "vitest";
import { createHostWorktreeRequester, type WorktreeHostTransport, type WorktreeHostMessage, type WorktreeHostResult } from "./hostWorktreeAdapter";

function setup() {
  const listeners = new Set<(event: { data: WorktreeHostResult }) => void>();
  const sent: WorktreeHostMessage[] = [];
  const transport: WorktreeHostTransport = {
    postMessage: vi.fn(message => { sent.push(message); }),
    addMessageListener: listener => { listeners.add(listener); },
    removeMessageListener: listener => { listeners.delete(listener); },
    createRequestId: () => "request-1",
    setTimeout: vi.fn((callback: () => void, _milliseconds: number): ReturnType<typeof setTimeout> => setTimeout(callback, 60_000)),
    clearTimeout: vi.fn(timeout => clearTimeout(timeout)),
  };
  return { transport, listeners, sent };
}

describe("createHostWorktreeRequester", () => {
  it("correlates the host response and releases its listener and timeout", async () => {
    const { transport, listeners, sent } = setup();
    const request = createHostWorktreeRequester(transport);
    const pending = request("task-1", "/workspace/project");
    expect(sent[0]).toMatchObject({ type: "create-agent-worktree", taskId: "task-1", workspaceRoot: "/workspace/project" });
    for (const listener of listeners) listener({ data: { type: "agent-worktree-result", requestId: "other", ok: true, path: "/wrong" } });
    expect(listeners.size).toBe(1);
    for (const listener of listeners) listener({ data: { type: "agent-worktree-result", requestId: "request-1", ok: true, path: "/tmp/worktree" } });
    await expect(pending).resolves.toBe("/tmp/worktree");
    expect(listeners.size).toBe(0);
    expect(transport.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it("rejects host failures and cleans up", async () => {
    const { transport, listeners } = setup();
    const pending = createHostWorktreeRequester(transport)("task-1", "/workspace");
    for (const listener of listeners) listener({ data: { type: "agent-worktree-result", requestId: "request-1", ok: false, error: "Git failed" } });
    await expect(pending).rejects.toThrow("Git failed");
    expect(listeners.size).toBe(0);
  });

  it("cleans up when posting throws synchronously", async () => {
    const { transport, listeners } = setup();
    vi.mocked(transport.postMessage).mockImplementation(() => { throw new Error("bridge closed"); });
    await expect(createHostWorktreeRequester(transport)("task-1", "/workspace")).rejects.toThrow("bridge closed");
    expect(listeners.size).toBe(0);
    expect(transport.clearTimeout).toHaveBeenCalledTimes(1);
  });

  it("times out and releases the pending listener", async () => {
    const { transport, listeners } = setup();
    let expire: (() => void) | undefined;
    transport.setTimeout = vi.fn((callback: () => void, milliseconds: number): ReturnType<typeof setTimeout> => {
      expire = callback;
      return setTimeout(callback, milliseconds);
    });
    const pending = createHostWorktreeRequester(transport, 10)("task-1", "/workspace");
    expect(listeners.size).toBe(1);
    expire?.();
    await expect(pending).rejects.toThrow(/timed out/i);
    expect(listeners.size).toBe(0);
    expect(transport.clearTimeout).toHaveBeenCalledWith(7);
  });

  it("rejects invalid requests without contacting the host", async () => {
    const { transport } = setup();
    await expect(createHostWorktreeRequester(transport)("", "/workspace")).rejects.toThrow(/required/i);
    expect(transport.postMessage).not.toHaveBeenCalled();
  });
});
