import type { AxiomFileEntry, AxiomPlatformAdapter } from "../../shared/platform";

type DesktopBridge = {
  secureStorage: {
    get(namespace: string, key: string): Promise<string | null>;
    set(namespace: string, key: string, value: string): Promise<{ stored: boolean }>;
    remove(namespace: string, key: string): Promise<boolean>;
  };
  project: {
    bootstrap(): Promise<{ workspaceRoot: string | null; platform: string }>;
    listFiles(path?: string): Promise<Array<{ name: string; path: string; kind: string }>>;
    readFile(path: string): Promise<{ path: string; content: string; size: number }>;
    writeFile(path: string, content: string): Promise<{ path: string; size: number }>;
  };
  remoteWorkspace: {
    list(): Promise<unknown[]>;
    create(request: unknown): Promise<unknown>;
    retryClone(id: string): Promise<unknown>;
    commitAndPush(request: unknown): Promise<unknown>;
    reconcile(id: string): Promise<unknown>;
    pushRecovered(request: unknown): Promise<unknown>;
    cancel(id: string): Promise<unknown>;
    cleanup(id: string): Promise<unknown>;
  };
  postMessage(message: unknown): void;
}

const unavailable = () => Promise.reject(new Error("Axiom's Electron platform bridge is unavailable."));

export function createDesktopPlatformAdapter(): AxiomPlatformAdapter {
  const bridge = typeof window !== "undefined" ? (window as Window & { axiomDesktop?: DesktopBridge }).axiomDesktop : undefined;
  const platform = "electron" as const;
  const createWorktree = async (taskId: string): Promise<string> => {
    if (!bridge) throw new Error("Git worktrees require the installed Axiom desktop application.");
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(taskId)) throw new Error("Invalid worktree task ID.");
    const { workspaceRoot } = await bridge.project.bootstrap();
    if (!workspaceRoot) throw new Error("Open a project before creating a Git worktree.");
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => { cleanup(); reject(new Error("Git worktree creation timed out.")); }, 65000);
      const listener = (event: MessageEvent) => {
        const message = event.data;
        if (!message || message.type !== "agent-worktree-result" || message.requestId !== requestId) return;
        cleanup();
        if (message.ok && typeof message.path === "string") resolve(message.path);
        else reject(new Error(typeof message.error === "string" ? message.error : "Git worktree creation failed."));
      };
      const cleanup = () => { window.clearTimeout(timeout); window.removeEventListener("message", listener); };
      window.addEventListener("message", listener);
      bridge.postMessage({ type: "create-agent-worktree", requestId, taskId, workspaceRoot });
    });
  };
  return Object.freeze({
    platform,
    capabilities: Object.freeze({
      secureStorage: !!bridge?.secureStorage,
      projectFiles: !!bridge?.project,
      gitWorktrees: !!bridge?.postMessage,
      nativeSpeech: false,
      shareTarget: typeof navigator !== "undefined" && !!navigator.share
    }),
    secureStorage: {
      get: (namespace: string, key: string) => bridge ? bridge.secureStorage.get(namespace, key) : unavailable(),
      set: async (namespace: string, key: string, value: string) => { if (!bridge) return unavailable(); await bridge.secureStorage.set(namespace, key, value); },
      remove: (namespace: string, key: string) => bridge ? bridge.secureStorage.remove(namespace, key) : unavailable()
    },
    documents: { pick: async () => { throw new Error('Use the desktop project file picker to select workspace files.'); } },
    files: {
      list: async (relativePath = ""): Promise<AxiomFileEntry[]> => { if (!bridge) return unavailable(); const entries = await bridge.project.listFiles(relativePath); return entries.map(entry => ({ name: entry.name, path: entry.path, type: entry.kind === "directory" ? "directory" : "file" })); },
      read: (relativePath: string) => bridge ? bridge.project.readFile(relativePath) : unavailable(),
      write: (relativePath: string, content: string) => bridge ? bridge.project.writeFile(relativePath, content) : unavailable()
    },
    git: {
      listWorkspaces: () => bridge ? bridge.remoteWorkspace.list() : unavailable(),
      createWorktree
    }
  });
}

let adapter: AxiomPlatformAdapter | undefined;
export function getDesktopPlatformAdapter(): AxiomPlatformAdapter {
  adapter ??= createDesktopPlatformAdapter();
  return adapter;
}
