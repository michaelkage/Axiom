export interface WorktreeHostMessage {
  type: "create-agent-worktree";
  requestId: string;
  taskId: string;
  workspaceRoot: string;
}
export interface WorktreeHostResult {
  type?: string;
  requestId?: string;
  ok?: boolean;
  path?: string;
  error?: string;
}
export interface WorktreeHostTransport {
  postMessage(message: WorktreeHostMessage): void;
  addMessageListener(listener: (event: { data: WorktreeHostResult }) => void): void;
  removeMessageListener(listener: (event: { data: WorktreeHostResult }) => void): void;
  createRequestId(): string;
  setTimeout(callback: () => void, milliseconds: number): ReturnType<typeof setTimeout>;
  clearTimeout(timeout: ReturnType<typeof setTimeout>): void;
}
const browserTransport: WorktreeHostTransport = {
  postMessage: message => {
    const bridge = (window as unknown as { axiomDesktop?: { postMessage(message: unknown): void } }).axiomDesktop;
    if (typeof bridge?.postMessage !== "function") throw new Error("Desktop host bridge is unavailable.");
    bridge.postMessage(message);
  },
  addMessageListener: listener => window.addEventListener("message", listener as unknown as EventListener),
  removeMessageListener: listener => window.removeEventListener("message", listener as unknown as EventListener),
  createRequestId: () => "axiom-worktree-" + crypto.randomUUID(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: timeout => clearTimeout(timeout),
};

/**
 * Request an isolated worktree from the trusted Electron host.
 * Correlates replies, bounds wait time and always releases its listener.
 */
export function createHostWorktreeRequester(
  transport: WorktreeHostTransport = browserTransport,
  timeoutMs = 35_000,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Worktree request timeout must be positive.");
  return (taskId: string, workspaceRoot: string): Promise<string> => {
    if (!taskId.trim() || !workspaceRoot.trim()) return Promise.reject(new Error("A task ID and workspace root are required."));
    const requestId = transport.createRequestId();
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        try {
          transport.removeMessageListener(onMessage);
        } catch {
          // Host teardown must not prevent the request promise from settling.
        }
        if (timeout !== undefined) {
          try {
            transport.clearTimeout(timeout);
          } catch {
            // Timer teardown is best-effort after the request has settled.
          }
        }
      };
      const finish = (result: { ok: true; path: string } | { ok: false; error: Error }) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (result.ok) resolve(result.path);
        else reject(result.error);
      };
      const onMessage = (event: { data: WorktreeHostResult }) => {
        const data = event.data;
        if (data?.type !== "agent-worktree-result" || data.requestId !== requestId) return;
        if (data.ok && typeof data.path === "string" && data.path.length > 0) finish({ ok: true, path: data.path });
        else finish({ ok: false, error: new Error(data.error || "The host could not create an isolated worktree.") });
      };
      try {
        transport.addMessageListener(onMessage);
        timeout = transport.setTimeout(() => finish({ ok: false, error: new Error("Timed out while creating the isolated agent worktree.") }), timeoutMs);
        transport.postMessage({ type: "create-agent-worktree", requestId, taskId, workspaceRoot });
      } catch (cause) {
        finish({ ok: false, error: cause instanceof Error ? cause : new Error(String(cause)) });
      }
    });
  };
}
