export type AxiomPlatform = "electron" | "ios" | "android" | "web";

export interface AxiomFileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface AxiomPlatformAdapter {
  readonly platform: AxiomPlatform;
  readonly capabilities: Readonly<{
    secureStorage: boolean;
    projectFiles: boolean;
    gitWorktrees: boolean;
    nativeSpeech: boolean;
    shareTarget: boolean;
  }>;
  secureStorage: {
    get(namespace: string, key: string): Promise<string | null>;
    set(namespace: string, key: string, value: string): Promise<void>;
    remove(namespace: string, key: string): Promise<boolean>;
  };
  files: {
    list(relativePath?: string): Promise<AxiomFileEntry[]>;
    read(relativePath: string): Promise<string>;
    write(relativePath: string, content: string): Promise<unknown>;
  };
  git: {
    listWorkspaces(): Promise<unknown[]>;
    createWorktree(taskId: string): Promise<string>;
  };
}
