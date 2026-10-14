import { createSignal, onMount, onCleanup, createContext, useContext, type ParentProps } from "solid-js";
import {
  createOpencodeClient,
  type OpencodeClient,
  type Event,
  type Agent,
  type Session,
  type Message as SDKMessage,
  type Part,
  type TextPartInput,
  type FilePartInput,
  type AgentPartInput,
  type SubtaskPartInput,
} from "@opencode-ai/sdk/v2/client";

import { hasAxiomDesktopApi, hasVscodeApi, vscode } from "../utils/vscode";
import { proxyFetch } from "../utils/proxyFetch";
import { proxyEventSource } from "../utils/proxyEventSource";
import { DEFAULT_AXIOM_RUNTIME, executeTaskBatches, planSubTasksWithOmniRoute, type AxiomSubTask } from "../../shared/axiomRuntime";
import { contextForSpecialist, inferSpecialist } from "../../shared/intelligence";

// Re-export types for convenience
export type { Event, Agent, Session, SDKMessage, Part };
export type PromptPartInput = TextPartInput | FilePartInput | AgentPartInput | SubtaskPartInput;

export type SSEStatus = {
  status: "connecting" | "connected" | "reconnecting" | "closed";
  attempt?: number;
  nextRetryMs?: number;
  reason?: "aborted" | "error" | "manual";
};

interface GlobalConfig {
  serverUrl: string;
  workspaceRoot?: string;
}

export interface InitData {
  currentSessionId?: string | null;
  currentSessionTitle?: string;
  currentSessionMessages?: Array<{ id: string; role: string }>;
  defaultAgent?: string;
}

function createOpenCode() {
  const [client, setClient] = createSignal<OpencodeClient | null>(null);
  const [isReady, setIsReady] = createSignal(false);
  const [workspaceRoot, setWorkspaceRoot] = createSignal<string | undefined>(undefined);
  const [initData, setInitData] = createSignal<InitData | null>(null);
  const [serverUrl, setServerUrl] = createSignal<string | undefined>(undefined);
  const [hostError, setHostError] = createSignal<string | null>(null);

  onMount(() => {
    // Check for standalone config (for E2E tests / web app)
    const globalConfig = (window as { OPENCODE_CONFIG?: GlobalConfig }).OPENCODE_CONFIG;
    if (globalConfig?.serverUrl) {
      const opencodeClient = createOpencodeClient({
        baseUrl: globalConfig.serverUrl,
        fetch: proxyFetch,
        directory: globalConfig.workspaceRoot,
      });
      setClient(opencodeClient);
      setServerUrl(globalConfig.serverUrl);
      setIsReady(true);
      if (globalConfig.workspaceRoot) {
        setWorkspaceRoot(globalConfig.workspaceRoot);
      }
      return; // Skip VSCode handshake
    }

    const handleMessage = (e: MessageEvent) => {
      const data = e.data;
      
      // Handle error messages from host
      if (data?.type === "error") {
        setHostError(data.message ?? "An unknown error occurred");
        return;
      }
      
      // Support both legacy 'init' and future 'server-url' message types
      if (data?.type === "init" || data?.type === "server-url") {
        const url = data.serverUrl ?? data.url;
        if (!url) return;

        // Store workspaceRoot for SSE subscriptions
        const wsRoot = data.workspaceRoot;
        if (wsRoot) {
          setWorkspaceRoot(wsRoot);
        }

        const opencodeClient = createOpencodeClient({
          baseUrl: url,
          fetch: proxyFetch,
          directory: wsRoot,
        });
        setClient(opencodeClient);
        setServerUrl(url);
        setIsReady(true);

        // Store initial session data from 'init' message
        if (data.type === "init") {
          setInitData({
            currentSessionId: data.currentSessionId,
            currentSessionTitle: data.currentSessionTitle,
            currentSessionMessages: data.currentSessionMessages,
            defaultAgent: data.defaultAgent,
          });
        }
      }
    };

    window.addEventListener("message", handleMessage);
    if (hasVscodeApi) {
      vscode.postMessage({ type: "ready" });
    }

    onCleanup(() => {
      window.removeEventListener("message", handleMessage);
    });
  });

  // High-level helper to send a prompt
  // Accepts optional messageID for idempotent sends
  async function sendPrompt(
    sessionId: string,
    text: string,
    agent?: string | null,
    extraParts: PromptPartInput[] = [],
    messageID?: string
  ) {
    const c = client();
    if (!c) throw new Error("Not connected");

    return c.session.prompt({
      sessionID: sessionId,
      parts: [{ type: "text", text }, ...extraParts],
      ...(agent ? { agent } : {}),
      ...(messageID ? { messageID } : {}),
    });
  }

  async function planParallelTasks(prompt: string) {
    const gateway = DEFAULT_AXIOM_RUNTIME.gatewayUrl.replace(/\/+$/, "");
    const response = await proxyFetch(gateway + "/models", {
      method: "GET",
      headers: { "Accept": "application/json" },
    });
    if (!response.ok) throw new Error(`OmniRoute model discovery failed (HTTP ${response.status}). Check that the local gateway is running.`);
    const modelResponse = await response.json() as { data?: Array<{ id?: string }> };
    const model = modelResponse.data?.find(item => typeof item.id === "string" && item.id.trim())?.id;
    if (!model) throw new Error("OmniRoute returned no available model IDs.");
    const tasks = await planSubTasksWithOmniRoute(prompt, model, DEFAULT_AXIOM_RUNTIME, proxyFetch);
    return { model, tasks };
  }

  async function createAgentWorktree(taskId: string, root: string): Promise<string> {
    if (!hasVscodeApi && !hasAxiomDesktopApi) throw new Error("Isolated agent worktrees require the Axiom desktop app or VS Code host.");
    const requestId = "axiom-worktree-" + Date.now() + "-" + Math.random().toString(36).slice(2);
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        clearTimeout(timeout);
      };
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; requestId?: string; ok?: boolean; path?: string; error?: string };
        if (data?.type !== "agent-worktree-result" || data.requestId !== requestId) return;
        cleanup();
        if (data.ok && data.path) resolve(data.path);
        else reject(new Error(data.error ?? "The host could not create an isolated worktree."));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while creating the isolated agent worktree."));
      }, 35000);
      window.addEventListener("message", onMessage);
      vscode.postMessage({ type: "create-agent-worktree", requestId, taskId, workspaceRoot: root });
    });
  }

  async function runSubAgentTasks(parentSessionId: string, tasks: AxiomSubTask[], preferredAgent?: string | null, orchestration?: { request: string; planSteps?: string[]; onOutcome?: (record: import("../../shared/axiomRuntime").TaskExecutionRecord) => void }) {
    const c = client();
    if (!c) throw new Error("Not connected to the OpenCode runtime.");
    const directory = workspaceRoot();
    const historyItems: Array<{ id: string; content: string; relevance: number; updatedAt: number }> = [];
    try {
      const historyResponse = await c.session.messages({ sessionID: parentSessionId });
      const history = (historyResponse.data ?? []) as unknown as Array<{
        info?: { id?: string; role?: string; time?: { created?: number } };
        parts?: Array<{ type?: string; text?: string }>;
      }>;
      for (const message of history.slice(-30)) {
        const text = (message.parts ?? []).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n");
        if (!text.trim()) continue;
        const role = message.info?.role ?? "unknown";
        historyItems.push({
          id: message.info?.id ?? "history-" + historyItems.length,
          content: role + ": " + text.slice(0, 6000),
          relevance: role === "user" ? 75 : 45,
          updatedAt: message.info?.time?.created ?? historyItems.length,
        });
      }
    } catch {
      // Context packing still works from the original request and plan if history is unavailable.
    }
    let availableAgentNames = new Set<string>();
    try {
      const agentResponse = await c.app.agents();
      availableAgentNames = new Set((agentResponse.data ?? []).map(agent => agent.name));
    } catch {
      // A missing agent catalogue should fall back to the OpenCode default agent.
    }
    return executeTaskBatches(tasks, async (task, completed) => {
      if (!directory) throw new Error("Cannot isolate agent task without a workspace root.");
      const taskDirectory = await createAgentWorktree(task.id, directory);
      const created = await c.session.create({
        directory: taskDirectory,
        parentID: parentSessionId,
        title: "Axiom: " + task.title,
      });
      if (created.error || !created.data?.id) {
        throw new Error(`Could not create child session for "${task.title}": ${created.error ? JSON.stringify(created.error) : "missing session ID"}`);
      }
      const childSessionId = created.data.id;
      const packed = contextForSpecialist({
        request: orchestration?.request ?? task.scope,
        taskTitle: task.title,
        taskScope: task.scope,
        targetFiles: task.targetFiles,
        planSteps: orchestration?.planSteps,
        conversation: historyItems,
        completedTasks: completed.map(entry => ({
          title: entry.task.title,
          status: "succeeded",
          summary: typeof entry.result === "object" && entry.result !== null && "summary" in entry.result ? String((entry.result as { summary: unknown }).summary) : undefined,
        })),
        constraints: ["Do not overlap with sibling tasks. Preserve unrelated behavior.", "Run focused checks where available and report exact commands and observed outcomes."],
      });
      const taskPrompt = [
        "Axiom parallel task: " + task.title,
        "Task scope: " + task.scope,
        "Declared target files: " + (task.targetFiles.length ? task.targetFiles.join(", ") : "(none declared; keep the scope narrow)"),
        "Acceptance criteria (each must be addressed and evidenced): " + (task.acceptanceCriteria?.length ? task.acceptanceCriteria.map((criterion, index) => (index + 1) + ". " + criterion).join("; ") : "Implement the declared scope and report concrete verification evidence."),
        "Isolated worktree path: " + taskDirectory,
        "Context budget: approximately " + packed.inputEstimatedTokens + " tokens before packing and " + packed.estimatedTokens + " after packing; estimated savings " + packed.estimatedSavingsTokens + " tokens (" + packed.estimatedSavingsPercent + "%). These are heuristic estimates, not provider-reported usage.",
        ...packed.items.map(item => "[" + item.kind + "] " + item.content),
        "This task runs in an isolated Git worktree created from repository HEAD. Do not assume uncommitted parent-workspace edits are present. Report the worktree path and changed files for explicit integration review.",
        "Follow the task scope and declared target-file restrictions. Treat context as guidance, not permission to exceed scope.",
      ].join("\n\n");
      const roleHint = task.agentHint ?? inferSpecialist(task.title + "\n" + task.scope);
      const matchingSpecialist = [...availableAgentNames].find(name => name.toLowerCase().includes(roleHint));
      const agent = task.agentHint && availableAgentNames.has(task.agentHint)
        ? task.agentHint
        : matchingSpecialist ?? (preferredAgent && availableAgentNames.has(preferredAgent) ? preferredAgent : undefined);
      const result = await c.session.prompt({
        sessionID: childSessionId,
        parts: [{ type: "text", text: taskPrompt }],
        ...(agent ? { agent } : {}),
      });
      if (result.error) {
        throw new Error("Task \"" + task.title + "\" failed: " + JSON.stringify(result.error));
      }
      let summary = "Agent prompt was accepted; review workspace changes and verification before merging.";
      try {
        const messagesResponse = await c.session.messages({ sessionID: childSessionId });
        const messages = (messagesResponse.data ?? []) as unknown as Array<{
          info?: { role?: string };
          parts?: Array<{ type?: string; text?: string }>;
        }>;
        const assistantMessages = messages.filter(message => message.info?.role === "assistant");
        const latest = assistantMessages[assistantMessages.length - 1];
        const text = (latest?.parts ?? []).filter(part => part.type === "text" && typeof part.text === "string").map(part => part.text).join("\n").trim();
        if (text) summary = text.slice(0, 1200);
      } catch {
        // A missing transcript must not turn a successful prompt response into a false failure.
      }
      return { sessionId: childSessionId, taskId: task.id, title: task.title, agent, summary, worktreePath: taskDirectory, contextEstimatedTokensBefore: packed.inputEstimatedTokens, contextEstimatedTokensAfter: packed.estimatedTokens, contextSavingsPercent: packed.estimatedSavingsPercent };
    }, orchestration?.onOutcome);
  }

  // Subscribe to events for the workspace through the extension proxy
  // (native EventSource has CORS issues in webview)
  function subscribeToEvents(
    onEvent: (event: Event) => void,
    onStatus?: (status: SSEStatus) => void
  ): () => void {
    const baseUrl = serverUrl();
    const dir = workspaceRoot();
    if (!baseUrl) throw new Error("Not connected");

    const url = new URL("/event", baseUrl);
    if (dir) {
      url.searchParams.set("directory", dir);
    }

    return proxyEventSource(
      url.toString(),
      (data) => {
        try {
          const parsed = JSON.parse(data);
          onEvent(parsed as Event);
        } catch (err) {
          console.error("[SSE] Failed to parse event:", err);
        }
      },
      (err) => {
        console.error("[SSE] EventSource error:", err);
      },
      onStatus
    );
  }

  // Respond to permission request
  async function respondToPermission(
    sessionId: string,
    permissionId: string,
    response: "once" | "always" | "reject"
  ) {
    const c = client();
    if (!c) throw new Error("Not connected");

    const dir = workspaceRoot();
    return c.permission.reply({
      reply: response,
      requestID: permissionId,
      ...(dir ? { directory: dir } : {}),
    });
  }

  // Revert to a previous message
  async function revertToMessage(sessionId: string, messageId: string) {
    const c = client();
    if (!c) throw new Error("Not connected");

    return c.session.revert({
      sessionID: sessionId,
      messageID: messageId,
    });
  }

  return {
    client,
    isReady,
    workspaceRoot,
    initData,
    hostError,
    setHostError,
    clearHostError: () => setHostError(null),
    // Expose SDK methods directly
    listSessions: () => {
      const dir = workspaceRoot();
      return client()?.session.list(dir ? { directory: dir } : undefined);
    },
    getSession: (id: string) => client()?.session.get({ sessionID: id }),
    createSession: () => {
      const dir = workspaceRoot();
      return client()?.session.create(dir ? { directory: dir } : undefined);
    },
    getAgents: () => client()?.app.agents(),
    getMessages: (id: string) => client()?.session.messages({ sessionID: id }),
    getConfig: () => {
      const dir = workspaceRoot();
      return client()?.config.get(dir ? { directory: dir } : undefined);
    },
    abortSession: (id: string) => client()?.session.abort({ sessionID: id }),
    // High-level helpers
    sendPrompt,
    planParallelTasks,
    runSubAgentTasks,
    subscribeToEvents,
    respondToPermission,
    revertToMessage,
  };
}

// Context
const OpenCodeContext = createContext<ReturnType<typeof createOpenCode>>();

export function OpenCodeProvider(props: ParentProps) {
  const value = createOpenCode();
  return <OpenCodeContext.Provider value={value}>{props.children}</OpenCodeContext.Provider>;
}

export function useOpenCode() {
  const context = useContext(OpenCodeContext);
  if (!context) throw new Error("useOpenCode must be used within OpenCodeProvider");
  return context;
}
