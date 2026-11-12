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

import { hasAxiomDesktopApi, hostBridge } from "../utils/hostBridge";
import { loadRelevantWorkerProjectMemories, runOpenCodeSubAgentTasks } from "../services/opencodeTaskOrchestrator";

import { runtimeEventSource } from "../utils/runtimeEventSource";
import { DEFAULT_AXIOM_RUNTIME, discoverOmniRouteModels, planSubTasksWithOmniRoute, resolveOmniRouteModel, type AxiomSubTask } from "../../shared/axiomRuntime";

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
        fetch,
        directory: globalConfig.workspaceRoot,
      });
      setClient(opencodeClient);
      setServerUrl(globalConfig.serverUrl);
      setIsReady(true);
      if (globalConfig.workspaceRoot) {
        setWorkspaceRoot(globalConfig.workspaceRoot);
      }
      return; // Standalone runtime config is already initialized
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
          fetch: fetch,
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
    if (hasAxiomDesktopApi) {
      hostBridge.postMessage({ type: "ready" });
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

  async function planParallelTasks(prompt: string, requestedModel?: string, configuredFallbackModel?: string) {
    const discovery = await discoverOmniRouteModels(DEFAULT_AXIOM_RUNTIME, fetch);
    if (!discovery.reachable) {
      throw new Error(discovery.warning ?? "OmniRoute is unreachable. Start the local gateway and retry.");
    }
    if (!discovery.models.length) {
      throw new Error(discovery.warning ?? "OmniRoute returned no available model IDs.");
    }
    // Until the UI exposes a model picker, use the first advertised model. Callers
    // that specify a model get strict inventory validation and only an explicit fallback.
    const requested = requestedModel?.trim() || discovery.models[0].id;
    const route = resolveOmniRouteModel(requested, discovery.models, configuredFallbackModel);
    if (!route.model) throw new Error(route.explanation ?? "The requested OmniRoute model is unavailable.");
    const tasks = await planSubTasksWithOmniRoute(prompt, route.model, DEFAULT_AXIOM_RUNTIME, fetch);
    return { model: route.model, models: discovery.models, tasks, discoveryWarning: discovery.warning, fallbackUsed: route.fallbackUsed, routingExplanation: route.explanation };
  }

  async function createAgentWorktree(taskId: string, root: string): Promise<string> {
    if (!hasAxiomDesktopApi) throw new Error("Isolated agent worktrees are available only in the Axiom desktop app.");
    const requestId = "axiom-worktree-" + crypto.randomUUID();
    return new Promise<string>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        window.removeEventListener("message", onMessage);
        if (timeout) clearTimeout(timeout);
      };
      const onMessage = (event: MessageEvent) => {
        const data = event.data as { type?: string; requestId?: string; ok?: boolean; path?: string; error?: string };
        if (data?.type !== "agent-worktree-result" || data.requestId !== requestId) return;
        cleanup();
        if (data.ok && data.path) resolve(data.path);
        else reject(new Error(data.error ?? "The host could not create an isolated worktree."));
      };
      timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out while creating the isolated agent worktree."));
      }, 35000);
      window.addEventListener("message", onMessage);
      try {
        hostBridge.postMessage({ type: "create-agent-worktree", requestId, taskId, workspaceRoot: root });
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async function runSubAgentTasks(parentSessionId: string, tasks: AxiomSubTask[], preferredAgent?: string | null, orchestration?: { request: string; planSteps?: string[]; signal?: AbortSignal; onOutcome?: (record: import("../../shared/axiomRuntime").TaskExecutionRecord) => void; onLog?: (taskId: string, line: string) => void }) {
    const c = client();
    if (!c) throw new Error("Not connected to the OpenCode runtime.");
    const directory = workspaceRoot();

    return runOpenCodeSubAgentTasks({
      parentSessionId,
      tasks,
      workspaceRoot: directory,
      preferredAgent,
      request: orchestration?.request ?? "",
      planSteps: orchestration?.planSteps,
      signal: orchestration?.signal,
      onOutcome: orchestration?.onOutcome,
      onLog: orchestration?.onLog,
      loadConversation: async () => {
        const historyResponse = await c.session.messages({ sessionID: parentSessionId });
        const history = (historyResponse.data ?? []) as unknown as Array<{
          info?: { id?: string; role?: string; time?: { created?: number } };
          parts?: Array<{ type?: string; text?: string }>;
        }>;
        const historyItems: Array<{ id: string; content: string; relevance: number; updatedAt: number }> = [];
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
        return historyItems;
      },
      loadProjectMemories: request => loadRelevantWorkerProjectMemories(directory, request),
      loadAvailableAgents: async () => {
        const agentResponse = await c.app.agents();
        return (agentResponse.data ?? []).map(agent => agent.name);
      },
      createWorktree: createAgentWorktree,
      createSession: input => c.session.create(input),
      promptSession: input => c.session.prompt(input),
      abortSession: sessionId => c.session.abort({ sessionID: sessionId }),
      getMessages: sessionId => c.session.messages({ sessionID: sessionId }) as unknown as Promise<{
        data?: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>;
      }>,
      subscribe: (onEvent, worktreePath) => subscribeToEvents(onEvent as (event: Event) => void, undefined, worktreePath),
    });
  }

  // Subscribe to events for the workspace directly from the standalone renderer
  // (native EventSource has CORS issues in webview)
  function subscribeToEvents(
    onEvent: (event: Event) => void,
    onStatus?: (status: SSEStatus) => void,
    directoryOverride?: string
  ): () => void {
    const baseUrl = serverUrl();
    const dir = directoryOverride ?? workspaceRoot();
    if (!baseUrl) throw new Error("Not connected");

    const url = new URL("/event", baseUrl);
    if (dir) {
      url.searchParams.set("directory", dir);
    }

    return runtimeEventSource(
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
  async function getProviderReadiness() {
    const c = client() as any;
    if (!c) throw new Error("The Axiom runtime is not connected. Wait for the runtime to finish starting, then refresh.");
    const response = await c.provider.list();
    if (response?.error) {
      const detail = typeof response.error === "string" ? response.error : response.error.message ?? JSON.stringify(response.error);
      throw new Error("Provider discovery failed: " + detail);
    }
    const data = response?.data ?? {};
    const allProviders = Array.isArray(data.all) ? data.all : [];
    const connectedIds = new Set<string>(Array.isArray(data.connected) ? data.connected : []);
    const modelMap = data.models && typeof data.models === "object" ? data.models : {};
    const warnings: string[] = [];
    if (!Array.isArray(data.all)) warnings.push("The runtime returned an unexpected provider catalogue shape. Update the bundled Axiom runtime if this persists.");
    const providers = allProviders.map((provider: any) => {
      const id = String(provider.id ?? provider.providerID ?? "");
      const rawModels = modelMap[id] && typeof modelMap[id] === "object" ? modelMap[id] : provider.models ?? {};
      const models = Object.entries(rawModels as Record<string, any>).map(([modelID, model]) => ({
        providerID: id,
        modelID,
        name: String(model?.name ?? modelID),
      })).sort((a, b) => a.name.localeCompare(b.name));
      return {
        id,
        name: String(provider.name ?? id),
        connected: connectedIds.has(id),
        models,
      };
    }).filter((provider: { id: string }) => Boolean(provider.id));
    if (providers.some((provider: { connected: boolean; models: unknown[] }) => provider.connected && provider.models.length === 0)) {
      warnings.push("At least one connected provider has no selectable models. Check its model configuration, local endpoint, and provider-specific requirements.");
    }
    return { providers, warnings };
  }

  async function testProviderConnection(providerID: string, modelID: string) {
    const c = client() as any;
    if (!c) throw new Error("The Axiom runtime is not connected. Wait for the runtime to finish starting, then try again.");
    try {
      const result = await c.model.default({
        prompt: "Reply with exactly: AXIOM_CONNECTION_OK",
        model: { providerID, modelID },
      });
      if (result?.error) {
        const error = result.error;
        const message = typeof error === "string" ? error : error.message ?? error.data?.message ?? JSON.stringify(error);
        throw new Error(String(message));
      }
      if (!result?.data) throw new Error("The provider returned no test response. Check credentials, model access, endpoint settings, and runtime logs.");
    } catch (cause) {
      const raw = cause instanceof Error ? cause.message : String(cause);
      const lower = raw.toLowerCase();
      if (/401|unauthori[sz]ed|invalid api.?key|authentication|credential/.test(lower)) {
        throw new Error("Authentication failed for " + providerID + "/" + modelID + ". Reconnect the provider or replace its credential in the runtime's credential store, then retry.");
      }
      if (/403|forbidden|permission|access denied/.test(lower)) {
        throw new Error("The provider denied access to " + providerID + "/" + modelID + ". Check account permissions, model access, and organization/project settings.");
      }
      if (/404|not found|model unavailable|unknown model/.test(lower)) {
        throw new Error("Model " + providerID + "/" + modelID + " was not found by the provider. Refresh model discovery and verify the exact model ID.");
      }
      if (/429|rate.?limit|quota|billing|insufficient.?credit/.test(lower)) {
        throw new Error("The provider reached a rate, quota, or billing limit. Check provider usage and billing, then retry when access is restored.");
      }
      if (/econnrefused|fetch failed|network|timed out|timeout|enotfound/.test(lower)) {
        throw new Error("The provider endpoint could not be reached. Check network access, local model-server status, and the configured base URL.");
      }
      throw new Error("Test request failed for " + providerID + "/" + modelID + ": " + raw);
    }
  }

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
    getProviderReadiness,
    testProviderConnection,
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
