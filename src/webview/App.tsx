import { createSignal, createMemo, Show, onMount, onCleanup, createEffect, For } from "solid-js";
import { InputBar } from "./components/InputBar";
import type { TiptapEditorMethods } from "./components/TiptapEditor";
import { MessageList } from "./components/MessageList";
import { TopBar } from "./components/TopBar";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { ContextIndicator } from "./components/ContextIndicator";
import { FileChangesSummary } from "./components/FileChangesSummary";
import { ChangeTopicsPanel } from "./components/ChangeTopicsPanel";
import { VerificationPanel } from "./components/VerificationPanel";
import { ProjectMemoryPanel } from "./components/ProjectMemoryPanel";
import { WorktreeReviewPanel } from "./components/WorktreeReviewPanel";
import { withProjectMemory } from "./utils/projectMemory";
import { RecoveryAdvice } from "./components/RecoveryAdvice";
import { ProviderOnboardingPanel } from "./components/ProviderOnboardingPanel";
import { getVerificationResult, skippedChecks } from "../shared/verification";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { useOpenCode, type PromptPartInput } from "./hooks/useOpenCode";
import { useSync } from "./state/sync";
import type { FilePartInput } from "@opencode-ai/sdk/v2/client";
import type { Message, Agent, Session, Permission, FileChangesInfo, MessagePart } from "./types";
import type { FileDiff } from "../shared/messages";
import { parseHostMessage } from "./types";
import { BUILTIN_PLUGIN_CATALOG, comboPromptForState, getAvailableCombos, reviewPluginManifest, suggestNextActions, type ExecutionSummary } from "../shared/intelligence";
import type { TaskExecutionRecord } from "../shared/axiomRuntime";

export interface QueuedMessage {
  id: string;
  text: string;
  agent: string | null;
  attachments: SelectionAttachment[];
}

// In-flight message tracking for the outbox (used for queue draining)
interface InFlightMessage {
  messageID: string;
  sessionId: string;
}

interface FileMentionInsertRequest {
  filePath: string;
  startLine?: number;
  endLine?: number;
}

interface SelectionAttachment {
  id: string;
  filePath: string;
  fileUrl: string;
  startLine?: number;
  endLine?: number;
}
import { vscode } from "./utils/vscode";
import { Id } from "./utils/id";
import { logger } from "./utils/logger";
import { extractMentions } from "./utils/editorContent";
import {
  encodeFileMentionReference,
  parseFileMentionReference,
} from "./utils/fileMentionReference";

const NEW_SESSION_KEY = "__new__";

function App() {
  // Use the sync context for server-owned state
  const sync = useSync();
  
  // Local UI-only state
  const [defaultAgent, setDefaultAgent] = createSignal<string | null>(null);
  const [workflowRun, setWorkflowRun] = createSignal<{ prompt: string; status: "running" | "complete" | "failed" } | null>(null);
  const [workflowError, setWorkflowError] = createSignal<string | null>(null);
  const [parallelPlan, setParallelPlan] = createSignal<{ model: string; tasks: import("../shared/axiomRuntime").AxiomSubTask[] } | null>(null);
  const [parallelPlanBusy, setParallelPlanBusy] = createSignal(false);
  const [parallelPlanError, setParallelPlanError] = createSignal<string | null>(null);
  const [taskOutcomes, setTaskOutcomes] = createSignal<TaskExecutionRecord[]>([]);
  const [taskAcceptanceCriteria, setTaskAcceptanceCriteria] = createSignal<Record<string, string[]>>({});
  const [installedPluginIds, setInstalledPluginIds] = createSignal<string[]>([]);
  const [drafts, setDrafts] = createSignal<Map<string, string>>(new Map());
  const [draftContents, setDraftContents] = createSignal<Map<string, any>>(new Map()); // TipTap JSON content
  const [sessionAgents, setSessionAgents] = createSignal<Map<string, string>>(new Map());
  const [selectionAttachmentsBySession, setSelectionAttachmentsBySession] = createSignal<
    Map<string, SelectionAttachment[]>
  >(new Map());
  
  // Editing state for previous messages
  const [editingMessageId, setEditingMessageId] = createSignal<string | null>(null);
  const [editingText, setEditingText] = createSignal<string>("");
  
  // Message queue for queuing messages while generating
  const [messageQueue, setMessageQueue] = createSignal<QueuedMessage[]>([]);

  // Host selections received before editor methods are available
  const [pendingMentionInsertions, setPendingMentionInsertions] = createSignal<FileMentionInsertRequest[]>([]);
  const [pendingEditorFocus, setPendingEditorFocus] = createSignal(false);
  
  // In-flight message tracking for outbox pattern
  const [inFlightMessage, setInFlightMessage] = createSignal<InFlightMessage | null>(null);
  
  // Editor methods for managing content
  let editorMethods: TiptapEditorMethods | null = null;

  // Get SDK hook for actions only
  const {
    initData,
    createSession,
    abortSession,
    sendPrompt,
    planParallelTasks,
    runSubAgentTasks,
    respondToPermission,
    revertToMessage,
    hostError,
    clearHostError,
  } = useOpenCode();

  // Get the current session key for drafts/agents
  const sessionKey = () => sync.currentSessionId() || NEW_SESSION_KEY;

  const getSdkErrorMessage = (error: unknown): string => {
    if (typeof error === "string" && error.length > 0) return error;
    if (!error || typeof error !== "object") return "Unknown error";

    const record = error as Record<string, unknown>;
    const topLevelMessage = record.message;
    if (typeof topLevelMessage === "string" && topLevelMessage.length > 0) {
      return topLevelMessage;
    }

    const data = record.data;
    if (data && typeof data === "object") {
      const dataMessage = (data as Record<string, unknown>).message;
      if (typeof dataMessage === "string" && dataMessage.length > 0) {
        return dataMessage;
      }
    }

    const nestedError = record.error;
    if (nestedError && typeof nestedError === "object") {
      const nestedRecord = nestedError as Record<string, unknown>;
      const nestedMessage = nestedRecord.message;
      if (typeof nestedMessage === "string" && nestedMessage.length > 0) {
        return nestedMessage;
      }
      const nestedData = nestedRecord.data;
      if (nestedData && typeof nestedData === "object") {
        const nestedDataMessage = (nestedData as Record<string, unknown>).message;
        if (typeof nestedDataMessage === "string" && nestedDataMessage.length > 0) {
          return nestedDataMessage;
        }
      }
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  };

  const getResponseStatus = (result: unknown): number | undefined => {
    if (!result || typeof result !== "object") return undefined;
    const response = (result as { response?: { status?: unknown } }).response;
    return typeof response?.status === "number" ? response.status : undefined;
  };
  
  // Derive current session title from store
  const isDefaultTitle = (title: string) => /^(New session|Child session) - \d{4}-\d{2}-\d{2}T/.test(title);
  const currentSessionTitle = createMemo(() => {
    const id = sync.currentSessionId();
    if (!id) return "New Session";
    const sessions = sync.sessions();
    const session = sessions.find(s => s.id === id);
    const title = session?.title;
    return title && !isDefaultTitle(title) ? title : "New Session";
  });

  // Current input for the active session
  const input = () => drafts().get(sessionKey()) || "";
  const setInput = (value: string) => {
    const key = sessionKey();
    setDrafts((prev) => {
      const next = new Map(prev);
      next.set(key, value);
      return next;
    });
    
    // Also save the editor JSON content when available
    if (editorMethods) {
      try {
        const json = editorMethods.getJSON();
        setDraftContents((prev) => {
          const next = new Map(prev);
          next.set(key, json);
          return next;
        });
      } catch (err) {
        // Editor might not be ready yet
      }
    }
  };

  // Current agent for the active session.
  // New-session mode always uses the global default; existing sessions can override it.
  const selectedAgent = () => {
    const sessionId = sync.currentSessionId();
    return sessionId ? sessionAgents().get(sessionId) || defaultAgent() : defaultAgent();
  };
  const setSelectedAgent = (agent: string | null) => {
    if (!agent) return;
    const sessionId = sync.currentSessionId();
    if (!sessionId) {
      // In new-session mode, agent choice defines the default for subsequent sessions.
      setDefaultAgent(agent);
      return;
    }
    setSessionAgents((prev) => {
      const next = new Map(prev);
      next.set(sessionId, agent);
      return next;
    });
  };
  
  // Convenience accessors from sync store
  // Use the sync memos directly (not wrapped in functions) to maintain reactivity
  const messages = sync.messages;
  const agents = sync.agents;
  const sessions = sync.sessions;
  const pendingPermissions = sync.aggregatedPermissions;
  const contextInfo = sync.contextInfo;
  const fileChanges = sync.fileChanges;
  const currentSessionDiffs = createMemo<FileDiff[]>(() => {
    const id = sync.currentSessionId();
    if (!id) return [];
    return sync.sessions().find((session) => session.id === id)?.summary?.diffs ?? [];
  });
  const verificationResults = createMemo(() => {
    const results = messages().flatMap((message) => sync.getParts(message.id))
      .map((part) => getVerificationResult(part as { id: string; tool?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string } }))
      .filter((result) => result !== null);
    const unique = new Map(results.map((result) => [result!.id, result!]));
    const observed = [...unique.values()];
    const run = workflowRun();
    if (run && run.status !== "running") {
      return [...observed, ...skippedChecks(["Tests", "Build"], observed)];
    }
    return observed;
  });
  const isThinking = sync.isThinking;
  const sessionError = sync.sessionError;

  const selectionAttachments = () => selectionAttachmentsBySession().get(sessionKey()) || [];
  const setSelectionAttachmentsForKey = (
    key: string,
    value: SelectionAttachment[] | ((prev: SelectionAttachment[]) => SelectionAttachment[])
  ) => {
    setSelectionAttachmentsBySession((prev) => {
      const next = new Map(prev);
      const current = next.get(key) || [];
      const updated = typeof value === "function" ? value(current) : value;
      next.set(key, updated);
      return next;
    });
  };
  const setSelectionAttachments = (
    value: SelectionAttachment[] | ((prev: SelectionAttachment[]) => SelectionAttachment[])
  ) => {
    setSelectionAttachmentsForKey(sessionKey(), value);
  };

  const getFilename = (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    const parts = normalized.split("/");
    return parts[parts.length - 1] || filePath;
  };

  const buildWorkspaceFileUrl = (workspaceRoot: string, relativePath: string) => {
    const normalizedRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedPath = relativePath.replace(/\\/g, "/").replace(/^\/+/, "");
    const base = `file://${normalizedRoot}/`;
    return new URL(normalizedPath, base).toString();
  };

  const openFileFromMention = (filePath: string) => {
    const workspaceRoot = sync.workspaceRoot();
    if (!workspaceRoot) {
      logger.error("Cannot open mention: workspace root unavailable", { filePath });
      return;
    }
    vscode.postMessage({
      type: "open-file",
      url: buildWorkspaceFileUrl(workspaceRoot, filePath),
    });
  };

  const formatSelectionLabel = (attachment: SelectionAttachment) => {
    const filename = getFilename(attachment.filePath);
    if (attachment.startLine && attachment.endLine && attachment.startLine !== attachment.endLine) {
      return `${filename} L${attachment.startLine}-${attachment.endLine}`;
    }
    if (attachment.startLine) {
      return `${filename} L${attachment.startLine}`;
    }
    return filename;
  };

  const buildSelectionParts = (attachments: SelectionAttachment[]): FilePartInput[] => {
    return attachments.map((attachment) => {
      const url = new URL(attachment.fileUrl);
      
      if (attachment.startLine !== undefined) {
        const start = attachment.endLine
          ? Math.min(attachment.startLine, attachment.endLine)
          : attachment.startLine;
        const end = attachment.endLine
          ? Math.max(attachment.startLine, attachment.endLine)
          : attachment.startLine;
        url.searchParams.set("start", String(start));
        url.searchParams.set("end", String(end));
      }
      
      return {
        type: "file" as const,
        mime: "text/plain",
        url: url.toString(),
        filename: getFilename(attachment.filePath),
        source: {
          type: "file" as const,
          path: attachment.filePath,
          text: {
            value: "",
            start: 0,
            end: 0,
          },
        },
      };
    });
  };

  const attachmentChips = createMemo(() =>
    selectionAttachments().map((attachment) => ({
      id: attachment.id,
      label: formatSelectionLabel(attachment),
      title: attachment.filePath,
    }))
  );

  const hasMessages = createMemo(() =>
    messages().some((m) => m.type === "user" || m.type === "assistant")
  );

  // Axiom's first workflow slice: make the intent and execution steps visible
  // before handing the request to the existing OpenCode runtime.
  const [workflowPlan, setWorkflowPlan] = createSignal<{ prompt: string; steps: string[] } | null>(null);
  let skipPlanOnce = false;

  const buildWorkflowSteps = (prompt: string): string[] => {
    const normalized = prompt.toLowerCase();
    const steps = ["Inspect the relevant project files and existing patterns"];
    if (/fix|bug|error|broken|crash|fail/.test(normalized)) {
      steps.push("Trace the problem to its root cause and identify a minimal fix");
    } else if (/design|landing|page|ui|interface|dashboard|frontend/.test(normalized)) {
      steps.push("Map the requested experience into focused UI and behavior changes");
    } else if (/test|coverage|verify|quality/.test(normalized)) {
      steps.push("Identify the behavior to validate and the most relevant checks");
    } else {
      steps.push("Break the requested outcome into small, coherent implementation changes");
    }
    steps.push("Implement the changes while preserving unrelated behavior");
    steps.push("Run relevant checks and inspect the actual diff");
    steps.push("Report changed files, verification evidence, remaining risks, and anything not tested");
    return steps;
  };

  const buildAcceptanceCriteria = (prompt: string): string[] => {
    const criteria = [
      "The requested outcome is implemented; unrelated behavior remains unchanged.",
      "The final diff is reviewable and limited to relevant files.",
      "Relevant checks are run where available, with actual results reported.",
      "Anything not run, blocked, or still uncertain is explicitly called out."
    ];
    if (/bug|fix|error|broken|crash|fail/i.test(prompt)) {
      criteria.unshift("The reported failure is traced to a cause and the fix addresses that cause.");
    }
    if (/test|coverage|verify|quality/i.test(prompt)) {
      criteria.unshift("The requested behavior has explicit pass/fail verification evidence.");
    }
    if (/ui|interface|design|page|dashboard|visual/i.test(prompt)) {
      criteria.unshift("The requested user flow and relevant empty, loading, and error states are addressed.");
    }
    return [...new Set(criteria)];
  };

  const requestWorkflowPlan = (prompt: string) => {
    setParallelPlan(null);
    setParallelPlanError(null);
    setWorkflowPlan({ prompt, steps: buildWorkflowSteps(prompt) });
  };

  const prepareParallelPlan = async (overridePrompt?: string) => {
    const plan = workflowPlan();
    const prompt = overridePrompt ?? plan?.prompt;
    if (!prompt || parallelPlanBusy()) return;
    setParallelPlanBusy(true);
    setParallelPlanError(null);
    try {
      const result = await planParallelTasks(prompt);
      setWorkflowPlan({ prompt, steps: buildWorkflowSteps(prompt) });
      setParallelPlan(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setParallelPlanError(message);
    } finally {
      setParallelPlanBusy(false);
    }
  };

  const executeParallelPlan = async () => {
    const plan = workflowPlan();
    const parallel = parallelPlan();
    if (!plan || !parallel || parallel.tasks.length === 0) return;
    setWorkflowError(null);
    setParallelPlanError(null);
    const activeSession = sync.currentSessionId();
    if (activeSession) sync.setSessionError(activeSession, null);
    setWorkflowRun({ prompt: plan.prompt, status: "running" });
    setTaskOutcomes([]);
    setTaskAcceptanceCriteria(Object.fromEntries(parallel.tasks.map(task => [task.id, task.acceptanceCriteria ?? ["Implement scope and report concrete verification evidence."]])));
    setWorkflowPlan(null);
    try {
      let parentSessionId = sync.currentSessionId();
      if (!parentSessionId) {
        const created = await createSession();
        const session = created?.data as Session | undefined;
        if (!session?.id) throw new Error("Could not create a parent session for parallel tasks.");
        parentSessionId = session.id;
        sync.setCurrentSessionId(parentSessionId);
      }
      const results = await runSubAgentTasks(parentSessionId, parallel.tasks, selectedAgent(), {
        request: plan.prompt,
        planSteps: plan.steps,
        onOutcome: record => setTaskOutcomes(previous => [...previous.filter(item => item.taskId !== record.taskId), record]),
      });
      const completed = results.map(({ task, result }) => {
        const outcome = taskOutcomes().find(item => item.taskId === task.id);
        const session = typeof result === "object" && result !== null && "sessionId" in result ? ", session " + String(result.sessionId) : "";
        const worktree = typeof result === "object" && result !== null && "worktreePath" in result ? ", isolated worktree " + String(result.worktreePath) : "";
        const summary = typeof result === "object" && result !== null && "summary" in result ? ", summary: " + String(result.summary).slice(0, 500) : "";
        return "- " + task.title + " (task " + task.id + "): " + (outcome?.status ?? "succeeded") + session + worktree + summary;
      }).join("\n");
      setParallelPlan(null);
      setWorkflowRun({ prompt: plan.prompt, status: "complete" });
      setInput("");
      logger.info("Parallel task execution finished; changes remain isolated pending explicit review and integration.", { outcomes: completed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkflowError(`Parallel execution stopped: ${message}. Some sibling tasks may already have changed files; review the workspace before retrying.`);
      setWorkflowRun({ prompt: plan.prompt, status: "failed" });
    }
  };

  const retryFailedRun = () => {
    const run = workflowRun();
    if (!run) return;
    const sessionId = sync.currentSessionId();
    if (sessionId) sync.setSessionError(sessionId, null);
    setWorkflowError(null);
    setInput(run.prompt);
    setWorkflowRun({ ...run, status: "running" });
    skipPlanOnce = true;
    void handleSubmit();
  };

  const executeWorkflowPlan = async () => {
    const plan = workflowPlan();
    if (!plan) return;
    setWorkflowPlan(null);
    setWorkflowError(null);
    const currentSessionId = sync.currentSessionId();
    if (currentSessionId) sync.setSessionError(currentSessionId, null);
    setWorkflowRun({ prompt: plan.prompt, status: "running" });
    const executionPrompt = `${plan.prompt}\n\nImplementation plan:\n${plan.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\nAcceptance criteria (treat these as a checklist, not as claims):\n${buildAcceptanceCriteria(plan.prompt).map(item => "- [ ] " + item).join("\n")}\n\nBefore reporting completion, inspect the actual changed-file list and diff. Run relevant checks that are available and report the exact result for each. Never infer that tests or builds passed because the agent finished. Clearly list checks not run, known limitations, and any manual review still needed. Leave changes reviewable; do not claim the task is verified unless the recorded evidence supports it.`;
    setInput(executionPrompt);
    skipPlanOnce = true;
    await handleSubmit();
  };

  // Find permissions that should show as standalone modals (not inline with tools)
  const standalonePermissions = createMemo(() => {
    const result: Permission[] = [];
    for (const [, perm] of pendingPermissions().entries()) {
      if (!perm.tool) {
        result.push(perm);
      }
    }
    return result;
  });

  const sessionsToShow = createMemo(() => {
    const root = sync.workspaceRoot();
    const currentId = sync.currentSessionId();
    
    return sessions()
      .filter(s => {
        // Only list sessions with primary agents (no parentID)
        if (s.parentID) return false;
        
        // Filter to sessions in the same repo/worktree
        if (root && s.directory !== root) return false;
        
        return true;
      })
      // Sort by edited time (updated) instead of started time (created)
      .sort((a, b) => b.time.updated - a.time.updated);
  });

  const normalizeSelectionRange = (startLine?: number, endLine?: number) => {
    if (startLine === undefined && endLine === undefined) return {};
    if (startLine === undefined || endLine === undefined) {
      const line = startLine ?? endLine;
      return { startLine: line, endLine: line };
    }
    return {
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
    };
  };

  const mentionInsertionKey = (request: FileMentionInsertRequest) =>
    encodeFileMentionReference({
      filePath: request.filePath,
      startLine: request.startLine,
      endLine: request.endLine,
    });

  const insertMentionFromHostSelection = (request: FileMentionInsertRequest): boolean => {
    if (!editorMethods) {
      return false;
    }

    try {
      const existingMentions = new Set(extractMentions(editorMethods.getJSON()));
      const requestKey = mentionInsertionKey(request);
      if (!existingMentions.has(requestKey)) {
        editorMethods.insertFileMention(request.filePath, request.startLine, request.endLine);
      }
      return true;
    } catch (err) {
      logger.error("Failed to insert file mention from editor selection", {
        error: err,
        filePath: request.filePath,
        startLine: request.startLine,
        endLine: request.endLine,
      });
      return false;
    }
  };

  const queueMentionInsertion = (request: FileMentionInsertRequest) => {
    const requestKey = mentionInsertionKey(request);
    setPendingMentionInsertions((prev) => {
      if (prev.some((item) => mentionInsertionKey(item) === requestKey)) {
        return prev;
      }
      return [...prev, request];
    });
  };

  const flushPendingMentionInsertions = () => {
    if (!editorMethods) return;
    const pending = pendingMentionInsertions();
    if (pending.length === 0) return;

    const failed: FileMentionInsertRequest[] = [];
    for (const request of pending) {
      if (!insertMentionFromHostSelection(request)) {
        failed.push(request);
      }
    }
    setPendingMentionInsertions(failed);
  };

  const focusEditorOrQueue = () => {
    if (!editorMethods) {
      setPendingEditorFocus(true);
      return;
    }
    editorMethods.focus();
    setPendingEditorFocus(false);
  };

  const handleEditorMethodsReady = (methods: TiptapEditorMethods) => {
    editorMethods = methods;
    if (pendingEditorFocus()) {
      editorMethods.focus();
      setPendingEditorFocus(false);
    }
    flushPendingMentionInsertions();
  };

  const insertMentionOrQueue = (request: FileMentionInsertRequest) => {
    if (insertMentionFromHostSelection(request)) {
      return;
    }
    queueMentionInsertion(request);
  };

  onMount(() => {
    const handleHostMessage = (event: MessageEvent) => {
      const parsed = parseHostMessage(event.data);
      if (!parsed) return;
      if (parsed.type !== "editor-selection") return;

      focusEditorOrQueue();
      const normalizedRange = normalizeSelectionRange(
        parsed.selection?.startLine,
        parsed.selection?.endLine
      );
      insertMentionOrQueue({
        filePath: parsed.filePath,
        startLine: normalizedRange.startLine,
        endLine: normalizedRange.endLine,
      });
    };

    window.addEventListener("message", handleHostMessage);
    onCleanup(() => window.removeEventListener("message", handleHostMessage));
  });

  // Set default agent from initData once available
  createEffect(() => {
    const init = initData();
    if (!init) return;
    
    const agentList = agents();
    const persistedDefault = init.defaultAgent;
    if (persistedDefault && agentList.some(a => a.name === persistedDefault)) {
      setDefaultAgent(persistedDefault);
    } else if (!defaultAgent() && agentList.length > 0) {
      setDefaultAgent(agentList[0].name);
    }
  });

  // Restore editor content when session changes
  createEffect(() => {
    const key = sessionKey();
    const savedContent = draftContents().get(key);
    
    if (editorMethods && savedContent) {
      try {
        editorMethods.setContent(savedContent);
      } catch (err) {
        logger.error("Failed to restore editor content", { error: err });
      }
    }
  });
  
  // Clear inFlightMessage when session becomes idle and trigger queue drain
  onMount(() => {
    const cleanup = sync.onSessionIdle((sessionId) => {
      const inflight = inFlightMessage();
      
      if (inflight?.sessionId !== sessionId) {
        return;
      }
      
      setInFlightMessage(null);
      if (workflowRun()?.status === "running") setWorkflowRun({ ...workflowRun()!, status: sessionError() ? "failed" : "complete" });
      
      // Schedule queue drain in a microtask to avoid interleaving with SSE batch
      queueMicrotask(() => {
        void processNextQueuedMessage();
      });
    });
    onCleanup(cleanup);
  });

  // Handlers
  const handleSubmit = async () => {
    const text = withProjectMemory(input().trim(), sync.workspaceRoot());
    if (!text || !sync.isReady()) {
      if (workflowRun()?.status === "running") {
        const message = !text ? "No prompt was available to run." : "Axiom is not connected to the OpenCode runtime.";
        setWorkflowError(message);
        setWorkflowRun({ ...workflowRun()!, status: "failed" });
      }
      return;
    }

    if (!skipPlanOnce) {
      requestWorkflowPlan(text);
      return;
    }
    skipPlanOnce = false;

    const agent = agents().some((a) => a.name === selectedAgent())
      ? selectedAgent()
      : null;
    const attachmentsKey = sessionKey();
    let attachments = selectionAttachments();
    
    // Extract mentions from editor and add to attachments
    if (editorMethods) {
      try {
        const editorJSON = editorMethods.getJSON();
        const mentionedFiles = extractMentions(editorJSON);
        const workspaceRoot = sync.workspaceRoot();
        if (!workspaceRoot) {
          throw new Error("workspace root unavailable while extracting mentions");
        }
        
        // Convert mention references to SelectionAttachment objects
        const mentionAttachments: SelectionAttachment[] = mentionedFiles.flatMap((mentionReference) => {
          const parsedMention = parseFileMentionReference(mentionReference);
          if (!parsedMention.filePath) return [];
          return [{
            id: `mention-${mentionReference}`,
            filePath: parsedMention.filePath,
            fileUrl: buildWorkspaceFileUrl(workspaceRoot, parsedMention.filePath),
            startLine: parsedMention.startLine,
            endLine: parsedMention.endLine,
          }];
        });
        
        // Merge with existing attachments (avoid exact duplicates)
        const attachmentKey = (attachment: SelectionAttachment) =>
          `${attachment.filePath}:${attachment.startLine ?? ""}:${attachment.endLine ?? ""}`;
        const existingKeys = new Set(attachments.map(attachmentKey));
        const newAttachments = mentionAttachments.filter(
          (attachment) => !existingKeys.has(attachmentKey(attachment))
        );
        attachments = [...attachments, ...newAttachments];
      } catch (err) {
        logger.error("Failed to extract mentions", { error: err });
      }
    }
    
    const extraParts = buildSelectionParts(attachments);

    // Generate sortable client-side messageID for idempotent sends
    const messageID = Id.ascending("message");

    // Ensure we have a session
    let sessionId = sync.currentSessionId();
    if (!sessionId) {
      try {
        const res = await createSession();
        const newSession = res?.data as Session | undefined;
        if (!newSession?.id) {
          const message = "The OpenCode runtime did not return a new session.";
          console.error("[App] Failed to create session");
          setWorkflowError(message);
          if (workflowRun()?.status === "running") setWorkflowRun({ ...workflowRun()!, status: "failed" });
          return;
        }
        sessionId = newSession.id;
        sync.setCurrentSessionId(sessionId);
      } catch (err) {
        const message = getSdkErrorMessage(err);
        console.error("[App] Failed to create session:", message);
        setWorkflowError(message);
        if (workflowRun()?.status === "running") setWorkflowRun({ ...workflowRun()!, status: "failed" });
        return;
      }
    }

    sync.setSessionError(sessionId, null);
    setWorkflowError(null);

    // Clear both text and JSON content
    setInput("");
    if (editorMethods) {
      editorMethods.clear();
    }
    const key = sessionKey();
    setDraftContents((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    sync.setThinking(sessionId, true);

    // Track this message as in-flight
    setInFlightMessage({ messageID, sessionId });

    logger.info("Sending prompt", { sessionId, messageID, textLen: text.length });

    try {
      const result = await sendPrompt(sessionId, text, agent, extraParts, messageID);
      
      // Log the full result for debugging
      const responseStatus = getResponseStatus(result);
      logger.info("sendPrompt result", { 
        hasError: !!result?.error, 
        hasData: !!result?.data,
        responseStatus,
      });
      
      // Check for SDK error in result (SDK doesn't throw by default)
      if (result?.error) {
        const errorMessage = getSdkErrorMessage(result.error);

        // Log full error structure for debugging
        logger.error("sendPrompt returned error", { 
          sessionId,
          messageID,
          responseStatus,
          errorMessage,
          error: result.error,
          response: result?.response,
        });

        sync.setThinking(sessionId, false);
        setInFlightMessage(null);
        sync.setSessionError(sessionId, errorMessage);
        setWorkflowError(errorMessage);
        if (workflowRun()?.status === "running") setWorkflowRun({ ...workflowRun()!, status: "failed" });
        return;
      }
      
      if (attachments.length > 0) {
        setSelectionAttachmentsForKey(attachmentsKey, []);
      }
    } catch (err) {
      logger.error("sendPrompt exception", { error: String(err), stack: (err as Error).stack });
      const errorMessage = (err as Error).message;
      
      // Show all errors inline and clear in-flight
      sync.setThinking(sessionId, false);
      setInFlightMessage(null);
      sync.setSessionError(sessionId, errorMessage);
      setWorkflowError(errorMessage);
      if (workflowRun()?.status === "running") setWorkflowRun({ ...workflowRun()!, status: "failed" });
    }
  };

  const processNextQueuedMessage = async () => {
    const queue = messageQueue();
    const inflight = inFlightMessage();
    const sessionId = sync.currentSessionId();
    
    if (queue.length === 0) {
      return;
    }
    
    // Don't process if there's already an in-flight message
    if (inflight) {
      return;
    }
    
    if (!sessionId || !sync.isReady()) {
      return;
    }
    
    const [next, ...rest] = queue;
    
    // Generate a FRESH messageID right before sending to ensure it's newer than the last assistant message
    // This is critical - IDs generated earlier (when queueing) will be older than assistant responses
    const messageID = Id.ascending("message");
    
    setMessageQueue(rest);
    sync.setThinking(sessionId, true);
    
    // Track this queued message as in-flight using the fresh messageID
    setInFlightMessage({ messageID, sessionId });

    try {
      const extraParts = buildSelectionParts(next.attachments);
      
      const result = await sendPrompt(sessionId, withProjectMemory(next.text, sync.workspaceRoot()), next.agent, extraParts, messageID);
      const responseStatus = getResponseStatus(result);
      
      // Check for SDK error in result (SDK doesn't throw by default)
      if (result?.error) {
        const errorMessage = getSdkErrorMessage(result.error);
        logger.error("queue sendPrompt returned error", {
          sessionId,
          messageID,
          responseStatus,
          errorMessage,
          error: result.error,
        });
        sync.setThinking(sessionId, false);
        setInFlightMessage(null);
        setMessageQueue([]);
        sync.setSessionError(sessionId, errorMessage);
        return;
      }
    } catch (err) {
      console.error("[App] Queue sendPrompt failed:", err);
      const errorMessage = (err as Error).message;
      
      // Show all errors inline and clear queue + in-flight
      sync.setThinking(sessionId, false);
      setInFlightMessage(null);
      setMessageQueue([]);
      sync.setSessionError(sessionId, errorMessage);
    }
  };

  const handleQueueMessage = () => {
    const text = input().trim();
    if (!text || !sync.isReady()) return;
    
    const agent = agents().some((a) => a.name === selectedAgent())
      ? selectedAgent()
      : null;
    const attachmentsKey = sessionKey();
    const attachments = selectionAttachments();
    
    // Queue the message without a messageID - we'll generate it fresh when sending
    const queuedMessage: QueuedMessage = {
      id: crypto.randomUUID(),
      text,
      agent,
      attachments,
    };
    
    setMessageQueue((prev) => [...prev, queuedMessage]);
    setInput("");
    if (editorMethods) {
      editorMethods.clear();
    }
    const key = sessionKey();
    setDraftContents((prev) => {
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
    if (attachments.length > 0) {
      setSelectionAttachmentsForKey(attachmentsKey, []);
    }
  };

  const handleRemoveFromQueue = (id: string) => {
    setMessageQueue((prev) => prev.filter((m) => m.id !== id));
  };

  const handleEditQueuedMessage = (id: string) => {
    const queue = messageQueue();
    const index = queue.findIndex((m) => m.id === id);
    if (index === -1) return;
    
    const message = queue[index];
    // Remove this message and all after it
    setMessageQueue(queue.slice(0, index));
    // Update editor first so setInput captures the new JSON draft content.
    if (editorMethods) {
      editorMethods.setContent(message.text);
    }
    // Put the message text in the input
    setInput(message.text);
    setSelectionAttachments(message.attachments);
    // Set the agent if different
    if (message.agent) {
      setSelectedAgent(message.agent);
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setSelectionAttachments((prev) => prev.filter((item) => item.id !== id));
  };

  const handleSessionSelect = async (sessionId: string) => {
    if (!sync.isReady()) return;
    
    // Clear local UI state
    setMessageQueue([]);
    setInFlightMessage(null);
    setEditingMessageId(null);
    setEditingText("");
    
    // Set session and bootstrap to load messages
    sync.setCurrentSessionId(sessionId);
    setWorkflowRun(null);
    await sync.bootstrap();
  };

  const handleNewSession = async () => {
    if (!sync.isReady()) return;
    try {
      const res = await createSession();
      const newSession = res?.data as Session | undefined;
      if (!newSession?.id) return;

      // Clear local UI state
      setMessageQueue([]);
      setInFlightMessage(null);
      setWorkflowRun(null);
      setEditingMessageId(null);
      setEditingText("");
      
      // Set new session and bootstrap
      sync.setCurrentSessionId(newSession.id);
      await sync.bootstrap();
    } catch (err) {
      console.error("[App] Failed to create session:", err);
    }
  };

  const handleCancel = async () => {
    const sessionId = sync.currentSessionId();
    if (!sync.isReady() || !sessionId) return;
    try {
      await abortSession(sessionId);
    } finally {
      sync.setThinking(sessionId, false);
      setInFlightMessage(null);
    }
  };

  const handleAgentChange = (agent: string | null) => {
    setSelectedAgent(agent);
    // Persist as global default for new sessions
    if (agent && !sync.currentSessionId()) {
      vscode.postMessage({ type: "agent-changed", agent });
    }
  };

  const handleStartEdit = (messageId: string, text: string) => {
    setEditingMessageId(messageId);
    setEditingText(text);
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setEditingText("");
  };

  const handleSubmitEdit = async (newText: string) => {
    const messageId = editingMessageId();
    const sessionId = sync.currentSessionId();
    if (!messageId || !sessionId || !newText.trim() || !sync.isReady()) return;

    const agent = agents().some((a) => a.name === selectedAgent())
      ? selectedAgent()
      : null;

    // Generate sortable client-side messageID for the new prompt
    const newMessageID = Id.ascending("message");

    sync.setThinking(sessionId, true);
    setEditingMessageId(null);
    setEditingText("");

    // Track this as in-flight
    setInFlightMessage({ messageID: newMessageID, sessionId });

    try {
      await revertToMessage(sessionId, messageId);
      const result = await sendPrompt(sessionId, newText.trim(), agent, [], newMessageID);
      const responseStatus = getResponseStatus(result);
      
      // Check for SDK error in result (SDK doesn't throw by default)
      if (result?.error) {
        const errorMessage = getSdkErrorMessage(result.error);
        logger.error("edit sendPrompt returned error", {
          sessionId,
          messageId,
          newMessageID,
          responseStatus,
          errorMessage,
          error: result.error,
        });
        sync.setThinking(sessionId, false);
        setInFlightMessage(null);
        sync.setSessionError(sessionId, `Error editing message: ${errorMessage}`);
        return;
      }
    } catch (err) {
      console.error("[App] Failed to edit message:", err);
      const errorMessage = (err as Error).message;
      
      // Show all errors inline and clear in-flight
      sync.setThinking(sessionId, false);
      setInFlightMessage(null);
      sync.setSessionError(sessionId, `Error editing message: ${errorMessage}`);
    }
  };

  const handlePermissionResponse = async (
    permissionId: string,
    response: "once" | "always" | "reject"
  ) => {
    const perms = pendingPermissions();
    let permission: Permission | undefined;
    for (const [, perm] of perms.entries()) {
      if (perm.id === permissionId) {
        permission = perm;
        break;
      }
    }

    const sessionId = permission?.sessionID || sync.currentSessionId();
    if (!sessionId || !sync.isReady()) {
      console.error("[App] Cannot respond to permission: no session ID");
      return;
    }

    await respondToPermission(sessionId, permissionId, response);
    // Permission removal is handled by store via SSE events
  };

  // Refresh sessions - just re-bootstrap
  const refreshSessions = async () => {
    await sync.bootstrap();
  };

  return (
    <div class={`app ${hasMessages() ? "app--has-messages" : ""}`}>
      <Show when={hostError()}>
        <div class="error-banner">
          <span class="error-banner__message">{hostError()}</span>
          <button class="error-banner__dismiss" onClick={clearHostError} aria-label="Dismiss error">×</button>
        </div>
      </Show>
      <Show when={sync.status().status === "error" || sync.status().status === "reconnecting"}>
        <section class="runtime-status-banner" role="status" aria-live="polite">
          <div>
            <strong>{sync.status().status === "reconnecting" ? "Reconnecting to the local runtime" : "The local runtime needs attention"}</strong>
            <p>{sync.status().status === "reconnecting" ? "Axiom is trying to restore its event connection. Wait briefly before retrying an operation." : sync.status().message || "The runtime connection or initial project data could not be loaded."}</p>
            <small>Project files are not changed by reconnecting. If this persists, check Help → Open Axiom Runtime Log.</small>
          </div>
          <button type="button" onClick={() => void sync.bootstrap().catch(error => logger.error("Manual runtime reconnect failed", { error }))}>Retry connection</button>
        </section>
      </Show>
      
      <TopBar
        sessions={sessionsToShow()}
        currentSessionId={sync.currentSessionId()}
        currentSessionTitle={currentSessionTitle()}
        sessionStatus={sync.sessionStatus}
        onSessionSelect={handleSessionSelect}
        onNewSession={handleNewSession}
        onRefreshSessions={refreshSessions}
      />

      <Show when={workflowRun()}>
        {(run) => (
          <section class={`workflow-run workflow-run--${run().status}`} aria-live="polite" aria-label="Build run status">
            <span class="workflow-run__indicator" aria-hidden="true" />
            <div class="workflow-run__copy">
              <strong>{run().status === "running" ? "Axiom is building" : run().status === "complete" ? "Response finished" : "Run needs attention"}</strong>
              <span>{run().status === "running" ? "Your plan was sent to the agent. Follow progress in the conversation." : run().status === "complete" ? "The agent response finished. This is not a quality-gate pass: review changed files and check results before accepting the work." : "The request did not complete successfully. Check the error in the conversation, then retry when ready."}</span>
            </div>
            <button type="button" class="workflow-run__dismiss" onClick={() => setWorkflowRun(null)} aria-label="Dismiss run status">×</button>
          </section>
        )}
      </Show>

      <Show when={(sessionError() || workflowError()) && workflowRun()?.status === "failed"}>
        <RecoveryAdvice error={(sessionError() || workflowError())!} onRetry={retryFailedRun} />
      </Show>
      <Show when={(sessionError() || workflowError() || workflowPlan()) && suggestNextActions({ lastFailure: sessionError() || workflowError() || undefined, hasPlan: Boolean(workflowPlan()), taskOutcomes: taskOutcomes() }).length > 0}>
        <section class="workflow-plan workflow-plan--suggestions" aria-label="Suggested next steps">
          <div class="workflow-plan__eyebrow">AXIOM INTELLIGENCE <span>UP NEXT</span></div>
          <h2>Keep the momentum</h2>
          <div class="workflow-plan__actions">
            <For each={suggestNextActions({ lastFailure: sessionError() || workflowError() || undefined, hasPlan: Boolean(workflowPlan()), taskOutcomes: taskOutcomes() })}>
              {(action) => <button class="workflow-plan__secondary" title={action.reason} onClick={() => setInput(action.prompt)}>{action.label} <span aria-hidden="true">→</span></button>}
            </For>
          </div>
        </section>
      </Show>
      <Show when={taskOutcomes().length > 0}>
        <section class="workflow-plan workflow-plan--task-outcomes" aria-label="Agent task outcomes">
          <div class="workflow-plan__eyebrow">AGENT ORCHESTRATION <span>{taskOutcomes().filter(item => item.status === "succeeded").length} / {taskOutcomes().length} SUCCEEDED</span></div>
          <h2>Build outcome</h2>
          <p class="workflow-plan__prompt">Agents report implementation outcomes; nothing is considered verified until the task quality gate passes. Review each task diff, run its checks, and integrate only the selected files.</p>
          <div class="workflow-plan__actions">
            <span>{taskOutcomes().filter(item => item.status === "succeeded").length} agent tasks succeeded</span>
            <span>{taskOutcomes().filter(item => item.status === "failed").length} failed</span>
            <span>{taskOutcomes().filter(item => item.status === "queued" || item.status === "running").length} remaining</span>
          </div>
          <Show when={taskOutcomes().some(item => item.status === "failed")}>
            <button class="workflow-plan__secondary" disabled={parallelPlanBusy()} onClick={() => {
              const prompt = "Replan unfinished work from actual task outcomes. Preserve successful tasks, isolate failure causes, block only dependent tasks, and schedule unrelated remaining work. Do not repeat completed tasks unless a dependency or verification result requires it.\n\n" + taskOutcomes().map(item => "- " + item.title + " [" + item.status + "]: " + (item.error || item.summary || "No details reported")).join("\n");
              void prepareParallelPlan(prompt);
            }}>{parallelPlanBusy() ? "Replanning…" : "Replan failed and remaining work"}</button>
          </Show>
          <ol>
            <For each={taskOutcomes()}>{(task) => <li>
              <strong>{task.title}</strong>
              <span>{task.status === "succeeded" ? "AGENT SUCCEEDED · REVIEW REQUIRED" : task.status.toUpperCase()}{task.agent ? " · " + task.agent : ""}{task.sessionId ? " · " + task.sessionId : ""}</span>
              <Show when={task.worktreePath}><WorktreeReviewPanel taskId={task.taskId} worktreePath={task.worktreePath!} workspaceRoot={sync.workspaceRoot()} acceptanceCriteria={taskAcceptanceCriteria()[task.taskId] ?? []} onRepair={async failure => { if (!task.sessionId) throw new Error("No task session is available for a bounded repair."); await sendPrompt(task.sessionId, withProjectMemory("Repair this task in its isolated worktree. Fix only the reported verification failures, preserve the task scope, and do not claim checks passed unless their exit status confirms it.\n\nFailure evidence:\n" + failure, sync.workspaceRoot()), task.agent); }} /></Show>
              <Show when={task.summary}><p>{task.summary}</p></Show>
              <Show when={typeof task.contextSavingsPercent === "number"}><p>Context compaction estimate: {task.contextEstimatedTokensBefore} → {task.contextEstimatedTokensAfter} tokens ({task.contextSavingsPercent}% estimated reduction)</p></Show>
              <Show when={task.error}><p>{task.error}</p></Show>
            </li>}</For>
          </ol>
          <div class="workflow-plan__actions">
            <For each={suggestNextActions({ lastFailure: sessionError() || workflowError() || undefined, hasPlan: Boolean(workflowPlan()), taskOutcomes: taskOutcomes() })}>
              {(action) => <button class="workflow-plan__secondary" title={action.reason} onClick={() => setInput(action.prompt)}>{action.label} →</button>}
            </For>
          </div>
        </section>
      </Show>

      <Show when={!hasMessages()}>
        <WelcomeScreen onSuggestion={(prompt) => setInput(prompt)} />
        <ProviderOnboardingPanel />
        <section class="workflow-plan workflow-plan--combos" aria-label="Quick workflow combos">
          <div class="workflow-plan__eyebrow">QUICK COMBOS <span>ONE TAP TO START</span></div>
          <div class="workflow-plan__actions">
            <For each={getAvailableCombos(installedPluginIds())}>{(combo) => <button class="workflow-plan__secondary" title={combo.description} onClick={() => setInput(comboPromptForState(combo, taskOutcomes() as ExecutionSummary[]))}>{combo.title} <span aria-hidden="true">→</span></button>}</For>
          </div>
        </section>
        <section class="workflow-plan workflow-plan--plugins" aria-label="Plugin marketplace">
          <div class="workflow-plan__eyebrow">AXIOM EXTENSIONS <span>BUILT-IN CATALOG</span></div>
          <h2>Workflow extensions</h2>
          <p class="workflow-plan__prompt">Discover declarative workflow packs. Unverified executable plugins are never downloaded or run from this catalog.</p>
          <div class="workflow-plan__actions">
            <For each={BUILTIN_PLUGIN_CATALOG}>{(plugin) => {
              const review = reviewPluginManifest(plugin);
              const enabled = () => installedPluginIds().includes(plugin.id);
              const safeTemplate = plugin.verified === true && plugin.permissions.every(permission => permission === "read-files");
              return <div class="workflow-plan__parallel">
                <strong>{plugin.id}</strong>
                <p>{plugin.description}</p>
                <span>{plugin.publisher} · v{plugin.version} · Permissions: {plugin.permissions.join(", ")}</span>
                <Show when={review.warnings.length > 0}><p>{review.warnings.join(" ")}</p></Show>
                <Show when={review.requiredApprovals.length > 0}><p>Requires explicit approval: {review.requiredApprovals.join(", ")}</p></Show>
                <button class="workflow-plan__secondary" disabled={!safeTemplate} onClick={() => setInstalledPluginIds(previous => enabled() ? previous.filter(id => id !== plugin.id) : [...previous, plugin.id])}>
                  {enabled() ? "Enabled for this session" : safeTemplate ? "Enable workflow pack" : "Blocked pending trust and sandbox"}
                </button>
              </div>;
            }}</For>
          </div>
        </section>
        <Show when={standalonePermissions().length > 0}>
          <div class="standalone-permissions">
            <For each={standalonePermissions()}>
              {(permission) => (
                <PermissionPrompt
                  permission={permission}
                  onResponse={handlePermissionResponse}
                  workspaceRoot={sync.workspaceRoot()}
                />
              )}
            </For>
          </div>
        </Show>
        
        <Show when={workflowPlan()} keyed>
          {(plan) => (
            <section class="workflow-plan" aria-label="Build plan">
              <div class="workflow-plan__eyebrow">AXIOM WORKFLOW <span>01 / PLAN</span></div>
              <h2>Here’s the build plan</h2>
              <p class="workflow-plan__prompt">{plan.prompt}</p>
              <ol>
                <For each={plan.steps}>{(step) => <li>{step}</li>}</For>
              </ol>
              <div class="workflow-plan__eyebrow">ACCEPTANCE CHECKLIST</div>
              <ul class="workflow-acceptance-criteria">
                <For each={buildAcceptanceCriteria(plan.prompt)}>{(criterion) => <li>{criterion}</li>}</For>
              </ul>
              <div class="workflow-plan__eyebrow">QUICK COMBOS</div>
              <div class="workflow-plan__actions" aria-label="Reusable workflows">
                <For each={getAvailableCombos(installedPluginIds())}>{(combo) => <button class="workflow-plan__secondary" title={combo.description} onClick={() => setInput(combo.prompt)}>{combo.title}</button>}</For>
              </div>
              <div class="workflow-plan__actions">
                <button class="workflow-plan__secondary" onClick={() => setWorkflowPlan(null)}>Keep editing</button>
                <button class="workflow-plan__secondary" disabled={parallelPlanBusy()} onClick={() => void prepareParallelPlan()}>{parallelPlanBusy() ? "Planning tasks…" : "Plan with OmniRoute"}</button>
                <button class="workflow-plan__primary" onClick={() => void executeWorkflowPlan()}>Run this plan <span aria-hidden="true">→</span></button>
              </div>
              <Show when={parallelPlanError()}><RecoveryAdvice error={parallelPlanError()!} onRetry={prepareParallelPlan} /></Show>
              <Show when={parallelPlan()} keyed>
                {(parallel) => <div class="workflow-plan__parallel">
                  <p>OmniRoute selected <strong>{parallel.model}</strong> and proposed {parallel.tasks.length} tasks. Tasks with overlapping target files are scheduled sequentially.</p>
                  <ol><For each={parallel.tasks}>{(task) => <li><strong>{task.title}</strong><span>{task.targetFiles.length ? task.targetFiles.join(", ") : task.scope}</span><Show when={task.dependsOn.length > 0}><small>Depends on: {task.dependsOn.join(", ")}</small></Show><ul><For each={task.acceptanceCriteria ?? ["Implement scope and report concrete verification evidence."]}>{criterion => <li>{criterion}</li>}</For></ul></li>}</For></ol>
                  <button class="workflow-plan__primary" onClick={() => void executeParallelPlan()}>Run with parallel agents <span aria-hidden="true">→</span></button>
                </div>}
              </Show>
            </section>
          )}
        </Show>
        <InputBar
          value={input()}
          onInput={setInput}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onQueue={handleQueueMessage}
          disabled={!sync.isReady()}
          isThinking={isThinking()}
          selectedAgent={selectedAgent()}
          agents={agents()}
          onAgentChange={handleAgentChange}
          queuedMessages={messageQueue()}
          onRemoveFromQueue={handleRemoveFromQueue}
          onEditQueuedMessage={handleEditQueuedMessage}
          attachments={attachmentChips()}
          onRemoveAttachment={handleRemoveAttachment}
          onFileMentionClick={openFileFromMention}
          editorRef={handleEditorMethodsReady}
        />
      </Show>

      <MessageList
        messages={messages()}
        isThinking={isThinking()}
        workspaceRoot={sync.workspaceRoot()}
        pendingPermissions={pendingPermissions}
        onPermissionResponse={handlePermissionResponse}
        editingMessageId={editingMessageId()}
        editingText={editingText()}
        onStartEdit={handleStartEdit}
        onCancelEdit={handleCancelEdit}
        onSubmitEdit={handleSubmitEdit}
        onEditTextChange={setEditingText}
        sessionError={sessionError()}
      />

      <Show when={hasMessages()}>
        <div class="input-divider" />
        <div class="input-status-row">
          <FileChangesSummary fileChanges={fileChanges()} />
          <ContextIndicator contextInfo={contextInfo()} />
        </div>
        <Show when={currentSessionDiffs().length > 0}>
          <ChangeTopicsPanel diffs={currentSessionDiffs()} />
        </Show>
        <VerificationPanel results={verificationResults()} />
        <ProjectMemoryPanel workspaceRoot={sync.workspaceRoot()} />
        
        <Show when={standalonePermissions().length > 0}>
          <div class="standalone-permissions">
            <For each={standalonePermissions()}>
              {(permission) => (
                <PermissionPrompt
                  permission={permission}
                  onResponse={handlePermissionResponse}
                  workspaceRoot={sync.workspaceRoot()}
                />
              )}
            </For>
          </div>
        </Show>
        
        <Show when={workflowPlan()} keyed>
          {(plan) => (
            <section class="workflow-plan" aria-label="Build plan">
              <div class="workflow-plan__eyebrow">AXIOM WORKFLOW <span>01 / PLAN</span></div>
              <h2>Here’s the build plan</h2>
              <p class="workflow-plan__prompt">{plan.prompt}</p>
              <ol>
                <For each={plan.steps}>{(step) => <li>{step}</li>}</For>
              </ol>
              <div class="workflow-plan__actions">
                <button class="workflow-plan__secondary" onClick={() => setWorkflowPlan(null)}>Keep editing</button>
                <button class="workflow-plan__secondary" disabled={parallelPlanBusy()} onClick={() => void prepareParallelPlan()}>{parallelPlanBusy() ? "Planning tasks…" : "Plan with OmniRoute"}</button>
                <button class="workflow-plan__primary" onClick={() => void executeWorkflowPlan()}>Run this plan <span aria-hidden="true">→</span></button>
              </div>
              <Show when={parallelPlanError()}><RecoveryAdvice error={parallelPlanError()!} onRetry={prepareParallelPlan} /></Show>
              <Show when={parallelPlan()} keyed>
                {(parallel) => <div class="workflow-plan__parallel">
                  <p>OmniRoute selected <strong>{parallel.model}</strong> and proposed {parallel.tasks.length} tasks. Tasks with overlapping target files are scheduled sequentially.</p>
                  <ol><For each={parallel.tasks}>{(task) => <li><strong>{task.title}</strong><span>{task.targetFiles.length ? task.targetFiles.join(", ") : task.scope}</span></li>}</For></ol>
                  <button class="workflow-plan__primary" onClick={() => void executeParallelPlan()}>Run with parallel agents <span aria-hidden="true">→</span></button>
                </div>}
              </Show>
            </section>
          )}
        </Show>
        <InputBar
          value={input()}
          onInput={setInput}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
          onQueue={handleQueueMessage}
          disabled={!sync.isReady()}
          isThinking={isThinking()}
          selectedAgent={selectedAgent()}
          agents={agents()}
          onAgentChange={handleAgentChange}
          queuedMessages={messageQueue()}
          onRemoveFromQueue={handleRemoveFromQueue}
          onEditQueuedMessage={handleEditQueuedMessage}
          attachments={attachmentChips()}
          onRemoveAttachment={handleRemoveAttachment}
          onFileMentionClick={openFileFromMention}
          editorRef={handleEditorMethodsReady}
        />
      </Show>
    </div>
  );
}

export default App;
