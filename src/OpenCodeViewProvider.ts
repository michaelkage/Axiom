import * as vscode from "vscode";
import { execFile } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import { OpenCodeService } from "./OpenCodeService";
import { getLogger } from "./extension";
import type {
  HostMessage,
  WebviewMessage,
  IncomingMessage,
} from "./shared/messages";
import { parseWebviewMessage } from "./shared/messages";
import { parseFileReferenceTarget } from "./shared/fileReferences";
import {
  SseClient,
  SseConnectionState,
  SseEvent,
  SseLogger,
} from "./transport/SseClient";

const LAST_AGENT_KEY = "opencode.lastUsedAgent";

interface DevServerConfig {
  origin: string;
  port: number;
  viteClientUrl: string;
  mainEntryUrl: string;
  wsOrigin: string;
}

export class OpenCodeViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode.chatView";
  private _view?: vscode.WebviewView;
  private _sseClients = new Map<string, SseClient>();
  private _proxyFetchControllers = new Map<string, AbortController>();
  private _webviewReady = false;
  private _pendingMessages: HostMessage[] = [];

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _openCodeService: OpenCodeService,
    private readonly _globalState: vscode.Memento,
  ) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    const logger = getLogger();
    logger.info("resolveWebviewView called");
    const devServerConfig = this._getDevServerConfig();
    if (devServerConfig) {
      logger.info("[ViewProvider] Using dev server for webview", {
        origin: devServerConfig.origin,
        port: devServerConfig.port,
        viteClientUrl: devServerConfig.viteClientUrl,
        mainEntryUrl: devServerConfig.mainEntryUrl,
      });
    }

    this._view = webviewView;
    this._webviewReady = false;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "out")],
      portMapping: devServerConfig
        ? [{ webviewPort: devServerConfig.port, extensionHostPort: devServerConfig.port }]
        : [],
    };

    const html = this._getHtmlForWebview(webviewView.webview, devServerConfig);
    logger.info("Generated webview HTML length:", html.length);
    webviewView.webview.html = html;

    webviewView.webview.onDidReceiveMessage(async (data: unknown) => {
      // Handle proxy messages directly (they don't go through parseWebviewMessage)
      if (typeof data === "object" && data !== null) {
        const msg = data as Record<string, unknown>;

        // Handle log messages from webview
        if (msg.type === "log") {
          const logger = getLogger();
          const level = msg.level as "debug" | "info" | "error";
          const message = msg.message as string;
          const logData = msg.data;
          if (level === "error") {
            logger.error(`[Webview] ${message}`, logData);
          } else if (level === "info") {
            logger.info(`[Webview] ${message}`, logData);
          } else {
            logger.debug(`[Webview] ${message}`, logData);
          }
          return;
        }

        if (msg.type === "create-agent-worktree") {
          await this._handleCreateAgentWorktree(msg as { requestId: string; taskId: string; workspaceRoot: string });
          return;
        }
        if (msg.type === "inspect-agent-worktree") {
          await this._handleInspectAgentWorktree(msg as { taskId: string; worktreePath: string; workspaceRoot: string });
          return;
        }
        if (msg.type === "apply-agent-worktree-changes") {
          await this._handleApplyAgentWorktreeChanges(msg as { taskId: string; worktreePath: string; workspaceRoot: string; paths: string[] });
          return;
        }
        if (msg.type === "run-agent-quality-gate") {
          await this._handleRunAgentQualityGate(msg as { taskId: string; worktreePath: string; workspaceRoot: string; changedPaths: string[] });
          return;
        }
        if (msg.type === "proxyFetch") {
          await this._handleProxyFetch(
            msg as {
              id: string;
              url: string;
              init?: {
                method?: string;
                headers?: Record<string, string>;
                body?: string;
              };
            },
          );
          return;
        }
        if (msg.type === "proxyFetchAbort") {
          this._handleProxyFetchAbort(msg.id as string);
          return;
        }
        if (msg.type === "sseSubscribe") {
          this._handleSSESubscribe(msg as { id: string; url: string });
          return;
        }
        if (msg.type === "sseClose") {
          this._handleSSEClose(msg.id as string);
          return;
        }
      }

      const message = parseWebviewMessage(data);
      if (!message) {
        console.warn(
          "[ViewProvider] Received invalid message from webview:",
          data,
        );
        return;
      }
      await this._handleWebviewMessage(message);
    });
  }

  private async _handleWebviewMessage(message: WebviewMessage) {
    switch (message.type) {
      case "ready":
        await this._handleReady();
        break;
      case "agent-changed":
        await this._handleAgentChanged(message.agent);
        break;
      case "open-file":
        await this._handleOpenFile(
          message.url,
          message.startLine,
          message.endLine,
        );
        break;
      case "search-files":
        await this._handleSearchFiles(message.query);
        break;
    }
  }

  private async _handleOpenFile(
    url: string,
    startLine?: number,
    endLine?: number,
  ) {
    try {
      const parsedTarget = parseFileReferenceTarget(url);
      const targetUrl = parsedTarget?.url ?? url;
      const resolvedStartLine = startLine ?? parsedTarget?.startLine;
      const resolvedEndLine = endLine ?? parsedTarget?.endLine;

      const uri = vscode.Uri.parse(targetUrl);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: true,
      });
      if (resolvedStartLine !== undefined) {
        const start = new vscode.Position(Math.max(resolvedStartLine - 1, 0), 0);
        const end = new vscode.Position(
          Math.max((resolvedEndLine ?? resolvedStartLine) - 1, 0),
          0,
        );
        const range = new vscode.Range(start, end);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      }
    } catch (error) {
      const logger = getLogger();
      logger.error("[ViewProvider] Failed to open file", { url, error });
      vscode.window.showErrorMessage("OpenCode: Failed to open file.");
    }
  }

  private async _handleCreateAgentWorktree(message: { requestId: string; taskId: string; workspaceRoot: string }) {
    const { requestId, taskId, workspaceRoot } = message;
    const fail = (error: string) => this._sendMessage({ type: "agent-worktree-result", requestId, ok: false, error });
    if (typeof requestId !== "string" || typeof taskId !== "string" || typeof workspaceRoot !== "string") {
      fail("Invalid isolated-worktree request.");
      return;
    }
    const workspace = vscode.workspace.workspaceFolders?.find(folder => folder.uri.fsPath === workspaceRoot);
    if (!workspace) {
      fail("The requested workspace is not an open VS Code workspace.");
      return;
    }
    const safeTaskId = taskId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48);
    if (!safeTaskId) {
      fail("Task ID did not contain safe path characters.");
      return;
    }
    const repoName = path.basename(workspaceRoot).replace(/[^a-zA-Z0-9_-]/g, "-");
    const target = path.join(os.tmpdir(), "axiom-agent-worktrees", repoName + "-" + safeTaskId + "-" + Date.now());
    try {
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["rev-parse", "--show-toplevel"], { cwd: workspaceRoot, timeout: 10000 }, (error, stdout) => {
          if (error) return reject(error);
          if (path.resolve(stdout.trim()) !== path.resolve(workspaceRoot)) {
            return reject(new Error("Open the Git repository root as the workspace before enabling isolated agent worktrees."));
          }
          resolve();
        });
      });
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await new Promise<void>((resolve, reject) => {
        execFile("git", ["worktree", "add", "--detach", target, "HEAD"], { cwd: workspaceRoot, timeout: 30000 }, error => {
          if (error) return reject(error);
          resolve();
        });
      });
      this._sendMessage({ type: "agent-worktree-result", requestId, ok: true, path: target });
    } catch (error) {
      fail("Could not create isolated Git worktree: " + (error instanceof Error ? error.message : String(error)));
    }
  }


  private async _handleInspectAgentWorktree(message: { taskId: string; worktreePath: string; workspaceRoot: string }) {
    const { taskId, worktreePath, workspaceRoot } = message;
    const send = (payload: Record<string, unknown>) => this._sendMessage({ type: "agent-worktree-review-result", taskId, ...payload } as unknown as HostMessage);
    const fail = (error: string) => send({ ok: false, error });
    if (![taskId, worktreePath, workspaceRoot].every(value => typeof value === "string" && value.length > 0)) {
      fail("Invalid worktree review request."); return;
    }
    const workspace = vscode.workspace.workspaceFolders?.find(folder => path.resolve(folder.uri.fsPath) === path.resolve(workspaceRoot));
    if (!workspace) { fail("The requested workspace is not open."); return; }
    const allowedRoot = path.resolve(os.tmpdir(), "axiom-agent-worktrees") + path.sep;
    const resolvedWorktree = path.resolve(worktreePath);
    if (!resolvedWorktree.startsWith(allowedRoot) || !fs.existsSync(path.join(resolvedWorktree, ".git"))) {
      fail("The path is not a registered Axiom worktree."); return;
    }
    const runGit = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => {
      execFile("git", args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) return reject(new Error((stderr || error.message).trim()));
        resolve(stdout);
      });
    });
    try {
      const [workspaceCommon, worktreeCommon] = await Promise.all([
        runGit(workspaceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
        runGit(resolvedWorktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
      ]);
      if (path.resolve(workspaceCommon.trim()) !== path.resolve(worktreeCommon.trim())) {
        fail("The worktree does not belong to the active workspace repository."); return;
      }
      const [nameStatus, patch, whitespace] = await Promise.all([
        runGit(resolvedWorktree, ["diff", "--name-status", "HEAD"]),
        runGit(resolvedWorktree, ["diff", "--no-ext-diff", "--no-color", "HEAD", "--"]),
        runGit(resolvedWorktree, ["diff", "--check", "HEAD"]),
      ]);
      const changedFiles = nameStatus.split(/\r?\n/).filter(Boolean).map(line => {
        const [status, ...fileParts] = line.split("\t");
        return { status, path: fileParts[fileParts.length - 1] ?? "" };
      });
      send({ ok: true, changedFiles, patch, whitespaceCheck: { passed: !whitespace.trim(), output: whitespace.trim() || "git diff --check passed." } });
    } catch (error) {
      fail("Could not inspect worktree diff: " + (error instanceof Error ? error.message : String(error)));
    }
  }

  private async _handleApplyAgentWorktreeChanges(message: { taskId: string; worktreePath: string; workspaceRoot: string; paths: string[] }) {
    const { taskId, worktreePath, workspaceRoot, paths } = message;
    const send = (payload: Record<string, unknown>) => this._sendMessage({ type: "agent-worktree-apply-result", taskId, ...payload } as unknown as HostMessage);
    const fail = (error: string) => send({ ok: false, error });
    if (typeof taskId !== "string" || typeof worktreePath !== "string" || typeof workspaceRoot !== "string" || !Array.isArray(paths) || !paths.every(p => typeof p === "string")) { fail("Invalid task integration request."); return; }
    const workspace = vscode.workspace.workspaceFolders?.find(folder => path.resolve(folder.uri.fsPath) === path.resolve(workspaceRoot));
    if (!workspace) { fail("The requested workspace is not open."); return; }
    const allowedRoot = path.resolve(os.tmpdir(), "axiom-agent-worktrees") + path.sep;
    const sourceRoot = path.resolve(worktreePath), targetRoot = path.resolve(workspaceRoot);
    if (!sourceRoot.startsWith(allowedRoot) || !fs.existsSync(path.join(sourceRoot, ".git"))) { fail("The path is not a registered Axiom worktree."); return; }
    const normalize = (value: string) => value.replace(/\\/g, "/").replace(/^\.\//, "");
    const safePaths = [...new Set(paths.map(normalize))];
    if (!safePaths.length || safePaths.some(p => !p || path.isAbsolute(p) || p.split("/").some(part => part === ".." || part === ""))) { fail("The selected file list contains an unsafe path."); return; }
    const runGit = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) => execFile("git", args, { cwd, timeout: 15000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error((stderr || error.message).trim())) : resolve(stdout)));
    try {
      const values = await Promise.all([runGit(workspaceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), runGit(sourceRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), runGit(sourceRoot, ["diff", "--name-only", "HEAD"]), runGit(sourceRoot, ["ls-files", "--others", "--exclude-standard"]), runGit(workspaceRoot, ["status", "--porcelain=v1", "--untracked-files=all"])]);
      if (path.resolve(values[0].trim()) !== path.resolve(values[1].trim())) { fail("The worktree does not belong to the active workspace repository."); return; }
      const available = new Set((values[2] + "\n" + values[3]).split(/\r?\n/).filter(Boolean).map(normalize));
      if (safePaths.some(p => !available.has(p))) { fail("The selection contains files that are not changed in this task worktree."); return; }
      const dirtyPaths = values[4].split(/\r?\n/).filter(Boolean).map(line => normalize(line.slice(3).split(" -> ").pop() || ""));
      const conflicts = safePaths.filter(p => dirtyPaths.includes(p));
      if (conflicts.length) { fail("Integration blocked to protect existing workspace edits in: " + conflicts.join(", ")); return; }
      const staged: Array<{ target: string; backup?: Buffer; existed: boolean }> = [];
      try {
        for (const relative of safePaths) {
          const source = path.resolve(sourceRoot, relative), target = path.resolve(targetRoot, relative);
          if (!source.startsWith(sourceRoot + path.sep) || !target.startsWith(targetRoot + path.sep)) throw new Error("Resolved path escaped its root.");
          let sourceStat: fs.Stats | undefined; try { sourceStat = await fs.promises.lstat(source); } catch { sourceStat = undefined; }
          let targetStat: fs.Stats | undefined; try { targetStat = await fs.promises.lstat(target); } catch { targetStat = undefined; }
          if (sourceStat && (!sourceStat.isFile() || sourceStat.isSymbolicLink())) throw new Error("Refusing to copy non-regular file: " + relative);
          if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) throw new Error("Refusing to replace non-regular file: " + relative);
          staged.push({ target, backup: targetStat ? await fs.promises.readFile(target) : undefined, existed: !!targetStat });
          if (sourceStat) { await fs.promises.mkdir(path.dirname(target), { recursive: true }); await fs.promises.copyFile(source, target); }
          else if (targetStat) await fs.promises.unlink(target);
        }
      } catch (error) {
        for (const item of staged.reverse()) { try { if (item.existed && item.backup) { await fs.promises.mkdir(path.dirname(item.target), { recursive: true }); await fs.promises.writeFile(item.target, item.backup); } else await fs.promises.rm(item.target, { force: true }); } catch { /* report original failure; rollback is best effort */ } }
        throw error;
      }
      send({ ok: true, appliedPaths: safePaths });
    } catch (error) { fail("Task integration failed: " + (error instanceof Error ? error.message : String(error))); }
  }

  private async _handleRunAgentQualityGate(message: { taskId: string; worktreePath: string; workspaceRoot: string; changedPaths: string[] }) {
    const { taskId, worktreePath, workspaceRoot, changedPaths } = message;
    const send = (payload: Record<string, unknown>) => this._sendMessage({ type: "agent-quality-gate-result", taskId, ...payload } as unknown as HostMessage);
    const fail = (error: string) => send({ ok: false, error });
    const allowedRoot = path.resolve(os.tmpdir(), "axiom-agent-worktrees") + path.sep, root = path.resolve(worktreePath);
    if (!taskId || !workspaceRoot || !root.startsWith(allowedRoot) || !fs.existsSync(path.join(root, ".git")) || !Array.isArray(changedPaths)) { fail("Invalid quality-gate request."); return; }
    const run = (command: string, args: string[], timeout = 120000) => new Promise<{ code: number; output: string }>(resolve => execFile(command, args, { cwd: root, timeout, maxBuffer: 12 * 1024 * 1024 }, (error, stdout, stderr) => resolve({ code: error ? (typeof (error as any).code === "number" ? (error as any).code : 1) : 0, output: (String(stdout || "") + String(stderr || "")).trim() })));
    const checks: Array<{ name: string; state: string; exitCode: number; output: string }> = [];
    const add = async (name: string, command: string, args: string[], timeout?: number) => { const result = await run(command, args, timeout); checks.push({ name, state: result.code === 0 ? "passed" : "failed", exitCode: result.code, output: result.output.slice(-12000) }); };
    try {
      const pkg = JSON.parse(await fs.promises.readFile(path.join(root, "package.json"), "utf8"));
      const scripts = pkg.scripts || {}, paths = changedPaths.map(p => p.toLowerCase());
      if (paths.some(p => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p)) && scripts.test) await add("Unit tests", "pnpm", ["exec", "vitest", "run"], 180000);
      if (paths.some(p => p.startsWith("src/webview/")) && fs.existsSync(path.join(root, "tsconfig.webview.json"))) await add("Webview type-check", "pnpm", ["exec", "tsc", "-p", "tsconfig.webview.json"], 120000);
      if (paths.some(p => p.startsWith("src/") && !p.startsWith("src/webview/")) && fs.existsSync(path.join(root, "tsconfig.json"))) await add("Extension type-check", "pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"], 120000);
      if (paths.some(p => p === "package.json" || p.endsWith(".json") || p.endsWith(".css") || p.endsWith(".tsx") || p.endsWith(".ts")) && scripts.build) await add("Production build", "pnpm", ["run", "build"], 240000);
      if (!checks.length) await add("Production build", "pnpm", ["run", "build"], 240000);
      const whitespace = await run("git", ["diff", "--check", "HEAD"], 15000);
      checks.push({ name: "Git whitespace check", state: whitespace.code === 0 ? "passed" : "failed", exitCode: whitespace.code, output: whitespace.output || "No whitespace errors." });
      const failed = checks.some(check => check.state === "failed");
      send({ ok: true, status: failed ? "Needs fixes" : "Ready to review", checks, changedPaths });
    } catch (error) { fail("Quality gate could not run: " + (error instanceof Error ? error.message : String(error))); }
  }
  private async _handleSearchFiles(query: string) {
    try {
      const logger = getLogger();
      logger.info("[ViewProvider] Searching files", { query });

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        this._sendMessage({ type: "search-files-result", files: [] });
        return;
      }

      const cwd = workspaceFolder.uri.fsPath;
      const lowerQuery = query.toLowerCase();

      const files = await new Promise<string[]>((resolve) => {
        execFile(
          "git",
          ["ls-files", "--cached", "--others", "--exclude-standard"],
          { cwd, maxBuffer: 10 * 1024 * 1024 },
          (error, stdout) => {
            if (error) {
              logger.error("[ViewProvider] git ls-files failed", { error });
              resolve([]);
              return;
            }
            const matches = stdout
              .split("\n")
              .filter((f) => f && f.toLowerCase().includes(lowerQuery))
              .slice(0, 50);
            resolve(matches);
          },
        );
      });

      logger.info("[ViewProvider] File search complete", {
        query,
        count: files.length,
      });

      this._sendMessage({
        type: "search-files-result",
        files,
      });
    } catch (error) {
      const logger = getLogger();
      logger.error("[ViewProvider] Failed to search files", { query, error });
      this._sendMessage({
        type: "search-files-result",
        files: [],
      });
    }
  }

  private async _handleReady() {
    try {
      const currentSessionId =
        this._openCodeService.getCurrentSessionId() ?? undefined;
      const currentSessionTitle =
        this._openCodeService.getCurrentSessionTitle();

      let messages: IncomingMessage[] | undefined;
      if (currentSessionId) {
        try {
          const sdkMessages =
            await this._openCodeService.getMessages(currentSessionId);
          // Transform SDK Message[] to IncomingMessage[]
          messages = sdkMessages.map((msg) => ({
            id: msg.id,
            role: msg.role,
          }));
        } catch (error) {
          console.error("Error loading session messages:", error);
          this._sendMessage({
            type: "error",
            message: `Failed to load session messages: ${(error as Error).message}`,
          });
        }
      }

      this._sendMessage({
        type: "init",
        ready: this._openCodeService.isReady(),
        workspaceRoot: this._openCodeService.getWorkspaceRoot(),
        serverUrl: this._openCodeService.getServerUrl(),
        currentSessionId,
        currentSessionTitle,
        currentSessionMessages: messages,
        defaultAgent: this._globalState.get<string>(LAST_AGENT_KEY),
      });
      this._webviewReady = true;
      this._flushPendingMessages();
    } catch (error) {
      console.error("Error handling ready:", error);
      this._sendMessage({
        type: "error",
        message: `Failed to initialize: ${(error as Error).message}`,
      });
      this._sendMessage({
        type: "init",
        ready: this._openCodeService.isReady(),
        workspaceRoot: this._openCodeService.getWorkspaceRoot(),
        serverUrl: this._openCodeService.getServerUrl(),
        currentSessionId: undefined,
      });
      this._webviewReady = true;
      this._flushPendingMessages();
    }
  }

  private async _handleAgentChanged(agent: string) {
    await this._globalState.update(LAST_AGENT_KEY, agent);
    const logger = getLogger();
    logger.info("[ViewProvider] Agent selection persisted:", agent);
  }

  // SSE Proxy handlers using resilient SseClient
  private _handleSSESubscribe(message: { id: string; url: string }) {
    const { id, url } = message;
    const logger = getLogger();

    if (typeof id !== "string" || typeof url !== "string") {
      logger.warn("[ViewProvider] Invalid sseSubscribe message", message);
      return;
    }

    const serverUrl = this._openCodeService.getServerUrl();
    if (!serverUrl) {
      this._sendMessage({
        type: "sseError",
        id,
        error: "OpenCode server URL not configured",
      } as HostMessage);
      return;
    }

    let target: URL;
    let allowed: URL;
    try {
      target = new URL(url);
      allowed = new URL(serverUrl);
    } catch {
      this._sendMessage({
        type: "sseError",
        id,
        error: "Invalid URL for SSE subscription",
      } as HostMessage);
      return;
    }

    if (target.origin !== allowed.origin) {
      this._sendMessage({
        type: "sseError",
        id,
        error: "SSE only allowed to OpenCode server origin",
      } as HostMessage);
      return;
    }

    // Close existing connection with this id
    this._handleSSEClose(id);

    // Create logger adapter for SseClient
    const sseLogger: SseLogger = {
      info: (msg, ...args) => logger.info(msg, ...args),
      warn: (msg, ...args) => logger.warn(msg, ...args),
      error: (msg, ...args) => logger.error(msg, ...args),
    };

    // Build headers including x-opencode-directory
    const headers: Record<string, string> = {};
    const workspaceRoot = this._openCodeService.getWorkspaceRoot();
    if (workspaceRoot) {
      // Encode directory as per SDK client (percent-encode non-ASCII)
      headers["x-opencode-directory"] = encodeURIComponent(workspaceRoot);
    }

    const client = new SseClient(url, {
      onEvent: (event: SseEvent) => {
        this._sendMessage({
          type: "sseEvent",
          id,
          data: event.data,
        } as HostMessage);
      },
      onStateChange: (state: SseConnectionState) => {
        logger.info("[ViewProvider] SSE state change", { id, state });

        // Send status to webview for observability
        if (state.status === "connecting") {
          this._sendMessage({
            type: "sseStatus",
            id,
            status: "connecting",
          } as HostMessage);
        } else if (state.status === "connected") {
          this._sendMessage({
            type: "sseStatus",
            id,
            status: "connected",
          } as HostMessage);
        } else if (state.status === "reconnecting") {
          this._sendMessage({
            type: "sseStatus",
            id,
            status: "reconnecting",
            attempt: state.attempt,
            nextRetryMs: state.nextRetryMs,
          } as HostMessage);
        } else if (state.status === "closed") {
          this._sendMessage({
            type: "sseStatus",
            id,
            status: "closed",
            reason: state.reason,
          } as HostMessage);
          this._sendMessage({ type: "sseClosed", id } as HostMessage);
          this._sseClients.delete(id);
        }
      },
      onError: (error: Error) => {
        logger.error("[ViewProvider] SSE unrecoverable error", {
          id,
          error: error.message,
        });
        this._sendMessage({
          type: "sseError",
          id,
          error: error.message,
        } as HostMessage);
        this._sseClients.delete(id);
      },
      logger: sseLogger,
      headers,
    });

    this._sseClients.set(id, client);
    client.connect();
    logger.info(
      "[ViewProvider] SSE subscription started with resilient client:",
      id,
    );
  }

  private _handleSSEClose(id: string) {
    const client = this._sseClients.get(id);
    if (client) {
      client.close();
      this._sseClients.delete(id);
    }
  }

  private _handleProxyFetchAbort(id: string) {
    const controller = this._proxyFetchControllers.get(id);
    if (controller) {
      controller.abort();
      this._proxyFetchControllers.delete(id);
    }
  }

  private async _handleProxyFetch(message: {
    id: string;
    url: string;
    init?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    };
  }) {
    const { id, url, init } = message;
    const logger = getLogger();

    if (typeof id !== "string" || typeof url !== "string") {
      logger.warn("[ViewProvider] Invalid proxyFetch message", message);
      return;
    }

    const serverUrl = this._openCodeService.getServerUrl();

    if (!serverUrl) {
      this._sendMessage({
        type: "proxyFetchResult",
        id,
        ok: false,
        error: "Proxy fetch disabled: OpenCode server URL not configured",
      } as HostMessage);
      return;
    }

    let target: URL;
    let allowed: URL;
    try {
      target = new URL(url);
      allowed = new URL(serverUrl);
    } catch {
      this._sendMessage({
        type: "proxyFetchResult",
        id,
        ok: false,
        error: "Invalid URL for proxy fetch",
      } as HostMessage);
      return;
    }

    if (target.origin !== allowed.origin) {
      this._sendMessage({
        type: "proxyFetchResult",
        id,
        ok: false,
        error: "Proxy fetch only allowed to OpenCode server origin",
      } as HostMessage);
      return;
    }

    const controller = new AbortController();
    this._proxyFetchControllers.set(id, controller);

    try {
      const res = await fetch(url, {
        method: init?.method,
        headers: init?.headers,
        body: init?.body,
        signal: controller.signal,
      });

      const bodyText = await res.text();

      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key] = value;
      });

      this._sendMessage({
        type: "proxyFetchResult",
        id,
        ok: true,
        status: res.status,
        statusText: res.statusText,
        headers,
        bodyText,
      } as HostMessage);
    } catch (error) {
      if ((error as Error).name === "AbortError") {
        logger.info("[ViewProvider] Proxy fetch aborted", { url, id });
        this._sendMessage({
          type: "proxyFetchResult",
          id,
          ok: false,
          error: "Aborted",
        } as HostMessage);
      } else {
        logger.error("[ViewProvider] Proxy fetch failed", { url, error });
        this._sendMessage({
          type: "proxyFetchResult",
          id,
          ok: false,
          error: String((error as Error)?.message ?? error),
        } as HostMessage);
      }
    } finally {
      this._proxyFetchControllers.delete(id);
    }
  }

  private _sendMessage(message: HostMessage) {
    if (this._view) {
      this._view.webview.postMessage(message);
    }
  }

  public sendHostMessage(message: HostMessage) {
    if (this._view && this._webviewReady) {
      this._view.webview.postMessage(message);
      return;
    }
    this._pendingMessages.push(message);
  }

  private _flushPendingMessages() {
    if (!this._view || this._pendingMessages.length === 0) return;
    const pending = this._pendingMessages;
    this._pendingMessages = [];
    for (const message of pending) {
      this._sendMessage(message);
    }
  }

  private _getDevServerConfig(): DevServerConfig | null {
    const raw = process.env.OPENCODE_DEV_SERVER_URL?.trim();
    if (!raw) return null;

    try {
      const parsed = new URL(raw);
      const originRoot = `${parsed.origin}/`;
      const viteClientUrl = new URL("/@vite/client", originRoot).toString();
      const mainEntryUrl = new URL("/src/webview/main.tsx", originRoot).toString();

      const wsUrl = new URL(originRoot);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";

      const port =
        parsed.port.length > 0
          ? Number(parsed.port)
          : parsed.protocol === "https:"
            ? 443
            : 80;

      return {
        origin: parsed.origin,
        port,
        viteClientUrl,
        mainEntryUrl,
        wsOrigin: wsUrl.origin,
      };
    } catch {
      getLogger().warn("[ViewProvider] Invalid OPENCODE_DEV_SERVER_URL; falling back to bundled webview");
      return null;
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview, devServerConfig: DevServerConfig | null) {
    if (devServerConfig) {
      return `<!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${devServerConfig.origin}; script-src 'unsafe-inline' ${devServerConfig.origin}; connect-src ${devServerConfig.origin} ${devServerConfig.wsOrigin} http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* ${webview.cspSource};">
          <title>OpenCode</title>
        </head>
        <body>
          <div id="root"></div>
          <script type="module" src="${devServerConfig.viteClientUrl}"></script>
          <script type="module" src="${devServerConfig.mainEntryUrl}"></script>
        </body>
        </html>`;
    }

    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "out", "main.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "out", "App.css"),
    );

    const nonce = getNonce();

    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://127.0.0.1:* ws://127.0.0.1:* http://localhost:* ws://localhost:* ${webview.cspSource};">
        <link href="${styleUri}" rel="stylesheet">
        <title>OpenCode</title>
      </head>
      <body>
        <div id="root"></div>
        <script type="module" nonce="${nonce}" src="${scriptUri}"></script>
      </body>
      </html>`;
  }
}

function getNonce() {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
