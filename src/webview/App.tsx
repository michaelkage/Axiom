import { createSignal, createMemo, Show, onMount, onCleanup, createEffect, For, lazy } from "solid-js";
import { InputBar } from "./components/InputBar";
import type { TiptapEditorMethods } from "./components/TiptapEditor";
import { MessageList } from "./components/MessageList";
import { TopBar } from "./components/TopBar";
import { TerminalPanel } from "./components/TerminalPanel";
import { WelcomeScreen } from "./components/WelcomeScreen";
import { ContextIndicator } from "./components/ContextIndicator";
import { FileChangesSummary } from "./components/FileChangesSummary";
import { ChangeTopicsPanel } from "./components/ChangeTopicsPanel";
import { VerificationPanel } from "./components/VerificationPanel";
const ProjectMemoryPanel = lazy(() => import("./components/ProjectMemoryPanel").then(module => ({ default: module.ProjectMemoryPanel })));
const WorktreeReviewPanel = lazy(() => import("./components/WorktreeReviewPanel").then(module => ({ default: module.WorktreeReviewPanel })));
import { withProjectMemory } from "./utils/projectMemory";
import { RecoveryAdvice } from "./components/RecoveryAdvice";
import { ProviderOnboardingPanel } from "./components/ProviderOnboardingPanel";
import { OmniRouteSetupPanel } from "./components/OmniRouteSetupPanel";
import { McpIntegrationsPanel } from "./components/McpIntegrationsPanel";
import { ProviderReadinessPanel } from "./components/ProviderReadinessPanel";
import { getVerificationResult, skippedChecks } from "../shared/verification";
import { PermissionPrompt } from "./components/PermissionPrompt";
import { useOpenCode, type PromptPartInput } from "./hooks/useOpenCode";
import { useSync } from "./state/sync";
import type { FilePartInput } from "@opencode-ai/sdk/v2/client";
import type { Message, Agent, Session, Permission, FileChangesInfo, MessagePart } from "./types";
import type { FileDiff } from "../shared/messages";
import { parseHostMessage } from "./types";
import { BUILTIN_PLUGIN_CATALOG, comboPromptForState, getAvailableCombos, reviewPluginManifest, suggestNextActions, type ExecutionSummary } from "../shared/intelligence";
import { createIndependentTasks, TaskBatchExecutionError, type TaskExecutionRecord } from "../shared/axiomRuntime";
import { decideTurboNext, getRequeueableBlockedTaskIds, type TurboTask } from "../shared/turboSupervisor";

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
import { hostBridge } from "./utils/hostBridge";
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
  const [parallelPlan, setParallelPlan] = createSignal<{ model: string; tasks: import("../shared/axiomRuntime").AxiomSubTask[]; fallbackUsed?: boolean; routingExplanation?: string; discoveryWarning?: string } | null>(null);
  const [omniRouteModels, setOmniRouteModels] = createSignal<Array<{ id: string; name: string }>>([]);
  const [requestedOmniRouteModel, setRequestedOmniRouteModel] = createSignal("");
  const [fallbackOmniRouteModel, setFallbackOmniRouteModel] = createSignal("");
  const [parallelPlanBusy, setParallelPlanBusy] = createSignal(false);
  const [parallelAbortController, setParallelAbortController] = createSignal<AbortController | null>(null);
  const [parallelPlanError, setParallelPlanError] = createSignal<string | null>(null);
  const [taskOutcomes, setTaskOutcomes] = createSignal<TaskExecutionRecord[]>([]);
  const [taskAcceptanceCriteria, setTaskAcceptanceCriteria] = createSignal<Record<string, string[]>>({});
  const [installedPluginIds, setInstalledPluginIds] = createSignal<string[]>([]);
  const [desktopProjectState, setDesktopProjectState] = createSignal<{ workspaceRoot: string; context: string; changes: Array<{ id: string; title: string; summary: string; status: string; createdAt: string; checks?: Array<{ name: string; state: string; details: string }>; files?: string[] }>; updatedAt: string | null } | null>(null);
  const [projectContextDraft, setProjectContextDraft] = createSignal("");
  const [desktopProjectNotice, setDesktopProjectNotice] = createSignal("");
  const [desktopProjectBusy, setDesktopProjectBusy] = createSignal(false);
  const [projectFiles, setProjectFiles] = createSignal<Array<{ name: string; path: string; kind: string }>>([]);
  const [projectFileDirectory, setProjectFileDirectory] = createSignal("");
  const [selectedProjectFile, setSelectedProjectFile] = createSignal("");
  const [projectFileContent, setProjectFileContent] = createSignal("");
  const [projectFileBusy, setProjectFileBusy] = createSignal(false);
  const [projectFileNotice, setProjectFileNotice] = createSignal("");

  const desktopApi = () => (window as Window & { axiomDesktop?: { project?: {
    bootstrap: () => Promise<{ workspaceRoot: string | null; appVersion: string; platform: string }>;
    readState: () => Promise<NonNullable<ReturnType<typeof desktopProjectState>>>;
    listWorkerTasks: () => Promise<TaskExecutionRecord[]>;
    recordWorkerTask: (task: TaskExecutionRecord) => Promise<TaskExecutionRecord>;
    saveContext: (context: string) => Promise<NonNullable<ReturnType<typeof desktopProjectState>>>;
    addChange: (change: { title: string; summary: string; status: string; files?: string[]; checks?: Array<{ name: string; state: string; details: string }> }) => Promise<NonNullable<ReturnType<typeof desktopProjectState>>>;
    chooseProject: () => Promise<string | null>;
    createProject: () => Promise<string | null>;
    listFiles: (relativePath: string) => Promise<Array<{ name: string; path: string; kind: string }>>;
    readFile: (relativePath: string) => Promise<{ path: string; content: string; size: number }>;
    writeFile: (relativePath: string, content: string) => Promise<{ path: string; size: number }>;
  } } }).axiomDesktop;
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
    getProviderReadiness,
    testProviderConnection,
  } = useOpenCode();

  // Get the current session key for drafts/agents
  const sessionKey = () => sync.currentSessionId() || NEW_SESSION_KEY;
  const withAxiomProjectContext = (prompt: string, workspaceRoot: string | undefined) => {
    const durableContext = desktopProjectState()?.context?.trim();
    const combined = durableContext
      ? "Persistent Axiom project context (user-maintained):\n" + durableContext + "\n\nCurrent request:\n" + prompt
      : prompt;
    return withProjectMemory(combined, workspaceRoot || "");
  };

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
  const runtimeStatusMessage = () => {
    const status = sync.status();
    return status.status === "error"
      ? status.message
      : status.status === "reconnecting"
        ? `Reconnect attempt ${status.attempt} is in progress.`
        : "The runtime connection or initial project data could not be loaded.";
  };

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
    hostBridge.postMessage({
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
  // before handing the request to the Axiom runtime.
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
      const result = await planParallelTasks(prompt, requestedOmniRouteModel() || undefined, fallbackOmniRouteModel() || undefined);
      setOmniRouteModels(result.models ?? []);
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
    const abortController = new AbortController();
    setParallelAbortController(abortController);
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
      // Keep successful work intact. Retry only workers with a confirmed failed or timed-out
      // terminal event, once, and never retry blocked/cancelled work automatically.
      // Serialize worker persistence per task. Worker log callbacks and terminal outcomes can
      // arrive close together; fire-and-forget writes must not let an older snapshot overwrite
      // a newer terminal status in the project store.
      const workerPersistenceByTask = new Map<string, Promise<void>>();
      const latestWorkerRecordByTask = new Map<string, TaskExecutionRecord>();
      const enqueueWorkerPersistence = (taskId: string) => {
        const previous = workerPersistenceByTask.get(taskId) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(async () => {
          // Read the freshest snapshot only when this queued write starts. Several
          // log/outcome callbacks may have arrived while an earlier write was pending.
          const latest = latestWorkerRecordByTask.get(taskId);
          if (latest) await desktopApi()?.project?.recordWorkerTask(latest);
        });
        workerPersistenceByTask.set(taskId, next);
        void next.catch(error => logger.error("Could not persist worker diagnostics", { taskId, error }));
      };
      const executionOptions = {
        request: plan.prompt,
        planSteps: plan.steps,
        signal: abortController.signal,
        onOutcome: (record: TaskExecutionRecord, originatingAttempt?: number) => {
          const prior = taskOutcomes().find(item => item.taskId === record.taskId);
          const mergedRecord = {
            ...prior,
            ...record,
            // Persist the supervisor's attempt generation so legitimate retries can
            // supersede terminal outcomes while delayed events from older attempts cannot.
            attempt: originatingAttempt ?? attemptsByTask.get(record.taskId) ?? record.attempt ?? prior?.attempt ?? 1,
            logs: record.logs ?? prior?.logs,
          };
          setTaskOutcomes(previous => [...previous.filter(item => item.taskId !== record.taskId), mergedRecord]);
          const project = desktopApi()?.project;
          latestWorkerRecordByTask.set(record.taskId, mergedRecord);
          if (project) enqueueWorkerPersistence(record.taskId);
          if (["succeeded", "failed", "blocked", "cancelled", "timed_out"].includes(record.status) && project) {
            const summary = record.status === "succeeded"
              ? "Worker session finished. Its changes remain isolated until reviewed and explicitly integrated."
              : record.status === "blocked"
                ? "Worker was blocked because a dependency did not succeed."
                : record.status === "timed_out"
                  ? "Worker exceeded its execution time limit. Review diagnostics before retrying."
                  : record.status === "cancelled"
                    ? "Worker execution was cancelled. Review its isolated worktree before retrying."
                    : "Worker session failed. Review the diagnostic details and isolated worktree before retrying.";
            void project.addChange({
              title: "Worker " + record.status + ": " + record.title,
              summary: [
                summary,
                record.error ? "Reason: " + record.error.slice(0, 700) : "",
                record.contextEstimatedTokensBefore != null ? "Estimated context before packing: " + record.contextEstimatedTokensBefore + " tokens." : "",
                record.contextEstimatedTokensAfter != null ? "Estimated context after packing: " + record.contextEstimatedTokensAfter + " tokens." : "",
                record.contextSavingsPercent != null ? "Estimated context reduction: " + record.contextSavingsPercent + "%." : "",
                record.summary ? "Worker result: " + record.summary.slice(0, 500) : "",
                record.logs?.length ? "Recent worker logs:\n" + record.logs.slice(-8).join("\n").slice(0, 1200) : "",
              ].filter(Boolean).join("\n\n"),
              status: record.status === "succeeded" ? "review" : "failed",
              checks: [{
                name: "Axiom worker lifecycle",
                state: record.status === "succeeded" ? "passed" : "failed",
                details: [
                  record.sessionId ? "Session: " + record.sessionId : "",
                  record.worktreePath ? "Worktree: " + record.worktreePath : "",
                  record.agent ? "Agent: " + record.agent : "",
                  record.startedAt ? "Started: " + new Date(record.startedAt).toISOString() : "",
                  record.finishedAt ? "Finished: " + new Date(record.finishedAt).toISOString() : "",
                  record.contextEstimatedTokensBefore != null ? "Context before: " + record.contextEstimatedTokensBefore + " tokens" : "",
                  record.contextEstimatedTokensAfter != null ? "Context after: " + record.contextEstimatedTokensAfter + " tokens" : "",
                  record.contextSavingsPercent != null ? "Estimated context reduction: " + record.contextSavingsPercent + "%" : "",
                ].filter(Boolean).join(" · ") || "No additional worker metadata was returned."
              }]
            }).then(() => window.dispatchEvent(new Event("axiom-project-state-updated"))).catch(error => logger.error("Could not persist worker lifecycle event", { taskId: record.taskId, error }));
          }
        },
        onLog: (taskId: string, line: string, originatingAttempt?: number) => {
          if (originatingAttempt != null && (attemptsByTask.get(taskId) ?? 0) !== originatingAttempt) return;
          const updated = taskOutcomes().map(item => item.taskId === taskId ? { ...item, logs: [...(item.logs ?? []), line].slice(-200) } : item);
          setTaskOutcomes(updated);
          const existing = updated.find(item => item.taskId === taskId);
          const project = desktopApi()?.project;
          if (existing && project) {
            latestWorkerRecordByTask.set(taskId, existing);
            enqueueWorkerPersistence(taskId);
          }
        },
      };
      let results: Awaited<ReturnType<typeof runSubAgentTasks>> = [];
      const turboStartedAt = Date.now();
      const maxTurboRuntimeMs = 10 * 60 * 1000;
      const maxAttemptsPerTask = 2;
      const maxTotalAttempts = Math.max(parallel.tasks.length, parallel.tasks.length * maxAttemptsPerTask);
      let retiredAttemptCount = 0;
      let supervisorTasks = [...parallel.tasks];
      let replanRound = 0;
      const attemptsByTask = new Map<string, number>(supervisorTasks.map(task => [task.id, 0]));
      const finalTaskSucceeded = (taskId: string) => taskOutcomes().some(outcome => outcome.taskId === taskId && outcome.status === "succeeded");
      const turboTasks = (): TurboTask[] => supervisorTasks.map(task => {
        const outcome = taskOutcomes().find(item => item.taskId === task.id);
        const attempts = attemptsByTask.get(task.id) ?? 0;
        const status = outcome?.status ?? "queued";
        return {
          id: task.id,
          title: task.title,
          dependsOn: task.dependsOn,
          acceptanceCriteria: task.acceptanceCriteria ?? [],
          attempts,
          maxAttempts: maxAttemptsPerTask,
          status: status === "running" || status === "succeeded" || status === "failed" || status === "blocked" || status === "cancelled" || status === "timed_out" ? status : "queued",
          lastError: outcome?.error,
        };
      });
      // All initial and replacement tasks enter through the supervisor loop below.
      // Dispatching the full plan here would run dependent tasks before their prerequisites
      // succeed, bypassing the dependency graph on the first attempt.

      // Drive retries from the same policy used by Turbo's pure decision engine.
      // Every iteration consumes a bounded attempt; successful siblings are retained.
      while (!abortController.signal.aborted) {
        const decision = decideTurboNext(turboTasks(), {
          maxParallelWorkers: Math.max(1, parallel.tasks.length),
          // Keep attempts from retired failed tasks in the global budget after replanning.
          maxTotalAttempts: Math.max(0, maxTotalAttempts - retiredAttemptCount),
          maxRuntimeMs: maxTurboRuntimeMs,
          startedAt: turboStartedAt,
          now: Date.now(),
          stopRequested: abortController.signal.aborted,
        });
        if (decision.action === "complete") break;
        if (decision.action === "stop") throw new Error("Turbo supervisor stopped: " + decision.reason);
        if (decision.action === "retry" || decision.action === "dispatch") {
          const selectedTasks = supervisorTasks.filter(task => decision.taskIds.includes(task.id));
          const runnable = selectedTasks.filter(task => {
            const status = taskOutcomes().find(item => item.taskId === task.id)?.status ?? "queued";
            if (decision.action === "retry") return (attemptsByTask.get(task.id) ?? 0) < maxAttemptsPerTask && ["failed", "timed_out"].includes(status);
            return status === "queued" || status === "blocked";
          });
          if (!runnable.length) throw new Error("Turbo supervisor requested " + decision.action + " but no task has a matching runnable state. " + decision.reason);
          if (decision.action === "retry") {
            for (const task of runnable) attemptsByTask.set(task.id, (attemptsByTask.get(task.id) ?? 0) + 1);
            logger.info("Turbo supervisor dispatching bounded worker retry", { taskIds: runnable.map(task => task.id), attempts: runnable.map(task => ({ id: task.id, attempt: attemptsByTask.get(task.id) })), reason: decision.reason });
          } else {
            // Initial dispatches and replacement tasks consume the same finite budget as retries.
            for (const task of runnable) attemptsByTask.set(task.id, (attemptsByTask.get(task.id) ?? 0) + 1);
            logger.info("Turbo supervisor dispatching dependency-ready worker tasks", { taskIds: runnable.map(task => task.id), attempts: runnable.map(task => ({ id: task.id, attempt: attemptsByTask.get(task.id) })), reason: decision.reason });
          }
          // Dependencies that have already succeeded in this run are satisfied for scheduling.
          // Worker changes remain isolated in their own worktrees; do not imply they were merged.
          const runnableTasks = runnable.map(task => ({
            ...task,
            dependsOn: task.dependsOn.filter(id => !finalTaskSucceeded(id)),
          }));
          try {
            // Bind callbacks to the exact attempt being dispatched. A timed-out runner may
            // still emit late events after the supervisor has started its retry.
            const dispatchedAttempts = new Map(runnable.map(task => [task.id, attemptsByTask.get(task.id) ?? 0]));
            const dispatchedExecutionOptions = {
              ...executionOptions,
              onOutcome: (record: TaskExecutionRecord) => {
                const attempt = dispatchedAttempts.get(record.taskId);
                if (attempt == null || (attemptsByTask.get(record.taskId) ?? 0) !== attempt) return;
                executionOptions.onOutcome(record, attempt);
              },
              onLog: (taskId: string, line: string) => {
                const attempt = dispatchedAttempts.get(taskId);
                if (attempt == null || (attemptsByTask.get(taskId) ?? 0) !== attempt) return;
                executionOptions.onLog(taskId, line, attempt);
              },
            };
            const dispatched = await runSubAgentTasks(parentSessionId, runnableTasks, selectedAgent(), dispatchedExecutionOptions);
            results = [...results.filter(item => !runnable.some(task => task.id === item.task.id)), ...dispatched];
          } catch (dispatchError) {
            if (!(dispatchError instanceof TaskBatchExecutionError)) throw dispatchError;
            results = [...results.filter(item => !runnable.some(task => task.id === item.task.id)), ...dispatchError.successfulResults] as typeof results;
          }
          // A blocked dependent becomes eligible only after every dependency has a confirmed
          // success event. Re-queue it explicitly so the supervisor can dispatch it next.
          const requeueableTaskIds = new Set(getRequeueableBlockedTaskIds(
            supervisorTasks,
            taskOutcomes().filter(outcome => outcome.status === "blocked").map(outcome => outcome.taskId),
            taskOutcomes().filter(outcome => outcome.status === "succeeded").map(outcome => outcome.taskId),
          ));
          setTaskOutcomes(previous => previous.map(outcome => {
            if (outcome.status !== "blocked" || !requeueableTaskIds.has(outcome.taskId)) return outcome;
            return { ...outcome, status: "queued", error: undefined, finishedAt: undefined };
          }));
          continue;
        }
        if (decision.action === "wait") {
          // runSubAgentTasks resolves only after its dispatched batch settles. If there are
          // no active calls here, a wait decision means the remaining graph is not runnable.
          throw new Error("Turbo supervisor cannot progress safely: " + decision.reason);
        }
        if (decision.action === "replan") {
          if (replanRound >= 2) throw new Error("Turbo reached its two-round replan limit. " + decision.reason);
          const affectedIds = new Set(decision.taskIds);
          let expandedAffected = true;
          while (expandedAffected) {
            expandedAffected = false;
            for (const task of supervisorTasks) {
              if (!affectedIds.has(task.id) && task.dependsOn.some(id => affectedIds.has(id)) && !finalTaskSucceeded(task.id)) {
                affectedIds.add(task.id);
                expandedAffected = true;
              }
            }
          }
          const failedTasks = supervisorTasks.filter(task => affectedIds.has(task.id));
          const diagnostics = failedTasks.map(task => {
            const outcome = taskOutcomes().find(item => item.taskId === task.id);
            return { id: task.id, title: task.title, scope: task.scope, targetFiles: task.targetFiles, acceptanceCriteria: task.acceptanceCriteria, attempts: attemptsByTask.get(task.id) ?? 0, error: outcome?.error ?? "No error detail was recorded", logs: (outcome?.logs ?? []).slice(-12) };
          });
          const successfulTasks = supervisorTasks.filter(task => finalTaskSucceeded(task.id)).map(task => ({ id: task.id, title: task.title, summary: taskOutcomes().find(item => item.taskId === task.id)?.logs?.slice(-3).join("\n") ?? "Succeeded; changes remain isolated for review." }));
          const replanPrompt = [
            "Replan only the failed coding work described below. Return a fresh, small task plan with explicit testable acceptance criteria.",
            "Do not repeat completed tasks. Successful sibling changes are isolated in separate worktrees and have NOT been merged into the parent workspace; do not assume their files are available. Keep replacement tasks independent of successful tasks and do not declare the overall goal complete.",
            "Original user goal: " + plan.prompt,
            "Failed work and real worker diagnostics:\n" + JSON.stringify(diagnostics, null, 2),
            "Already successful work (informational only; do not duplicate):\n" + JSON.stringify(successfulTasks, null, 2),
          ].join("\n\n");
          logger.info("Turbo supervisor requesting a bounded diagnostic replan", { round: replanRound + 1, failedTaskIds: failedTasks.map(task => task.id) });
          const replanned = await planParallelTasks(replanPrompt, requestedOmniRouteModel() || undefined, fallbackOmniRouteModel() || undefined);
          if (abortController.signal.aborted) throw new Error("Turbo execution cancelled while replanning.");
          // Treat planner output as untrusted input: reject malformed graphs and unsafe paths
          // before creating worker sessions or allocating replacement worktrees.
          if (!replanned.tasks.length) throw new Error("Planner returned no replacement work.");
          for (const task of replanned.tasks) {
            if (!task.id.trim() || !task.title.trim() || !task.scope.trim()) {
              throw new Error("Planner returned a replacement task without an ID, title, or scope.");
            }
            if (!task.acceptanceCriteria?.length || task.acceptanceCriteria.some(criterion => !criterion.trim())) {
              throw new Error("Replacement task " + task.id + " is missing explicit acceptance criteria.");
            }
            for (const targetPath of task.targetFiles) {
              const normalizedPath = targetPath.replace(/\\/g, "/");
              if (!normalizedPath.trim() || normalizedPath.startsWith("/") || /^[a-zA-Z]:/.test(normalizedPath) || normalizedPath.split("/").some(part => part === ".." || part === "")) {
                throw new Error("Replacement task " + task.id + " contains an unsafe target path: " + targetPath);
              }
            }
          }
          // Validate IDs, dependencies, and acyclic scheduling before any worker is launched.
          createIndependentTasks(replanned.tasks);
          const failedIds = new Set(failedTasks.map(task => task.id));
          const replacementTasks = replanned.tasks.map((task, index) => ({
            ...task,
            id: "replan-" + (replanRound + 1) + "-" + index + "-" + task.id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48),
            // The original failed tasks were only dispatched after their dependencies succeeded.
            // Replacement work is intentionally independent because sibling worktrees are isolated.
            dependsOn: task.dependsOn.map(id => "replan-" + (replanRound + 1) + "-" + replanned.tasks.findIndex(candidate => candidate.id === id) + "-" + id.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48)),
          }));
          // Preserve historical attempts when removing failed tasks from the active graph;
          // otherwise each replan would reset the global safety budget.
          retiredAttemptCount += failedTasks.reduce((sum, task) => sum + (attemptsByTask.get(task.id) ?? 0), 0);
          supervisorTasks = [...supervisorTasks.filter(task => !failedIds.has(task.id)), ...replacementTasks];
          for (const task of replacementTasks) attemptsByTask.set(task.id, 0);
          replanRound += 1;
          logger.info("Turbo supervisor accepted validated replacement tasks", { round: replanRound, replacedTaskIds: [...failedIds], replacementTaskIds: replacementTasks.map(task => task.id) });
          continue;
        }
        if (decision.action === "blocked") {
          throw new Error("Turbo supervisor requires intervention: " + decision.reason + " Tasks: " + decision.taskIds.join(", "));
        }
        throw new Error("Turbo supervisor reached an unsupported decision: " + decision.action);
      }
      if (abortController.signal.aborted) throw new Error("Turbo execution cancelled by the user.");
      const requiredTaskIds = new Set(supervisorTasks.map(task => task.id));
      const requiredResults = results.filter(item => requiredTaskIds.has(item.task.id));
      const completed = requiredResults.map(({ task, result }) => {
        const outcome = taskOutcomes().find(item => item.taskId === task.id);
        const session = typeof result === "object" && result !== null && "sessionId" in result ? ", session " + String(result.sessionId) : "";
        const worktree = typeof result === "object" && result !== null && "worktreePath" in result ? ", isolated worktree " + String(result.worktreePath) : "";
        const summary = typeof result === "object" && result !== null && "summary" in result ? ", summary: " + String(result.summary).slice(0, 500) : "";
        return "- " + task.title + " (task " + task.id + "): " + (outcome?.status ?? "missing terminal outcome") + session + worktree + summary;
      }).join("\n");
      const finalOutcomes = taskOutcomes();
      const allWorkersSucceeded = requiredResults.length === supervisorTasks.length
        && supervisorTasks.every(task => finalOutcomes.some(outcome => outcome.taskId === task.id && outcome.status === "succeeded"));
      if (!allWorkersSucceeded) {
        throw new Error("The worker batch returned without a confirmed succeeded lifecycle event for every planned task. Review worker diagnostics before treating this run as complete. " + completed);
      }
      setParallelPlan(null);
      setWorkflowRun({ prompt: plan.prompt, status: "complete" });
      setInput("");
      logger.info("Parallel task execution finished; changes remain isolated pending explicit review and integration.", { outcomes: completed });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setWorkflowError(`${abortController.signal.aborted ? "Parallel execution cancelled" : "Parallel execution stopped"}: ${message}. Some sibling tasks may already have changed files; review the workspace before retrying.`);
      setWorkflowRun({ prompt: plan.prompt, status: "failed" });
    } finally {
      setParallelAbortController(null);
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

  // Hydrate project-scoped memory from the trusted Electron bridge. Browser/extension
  // development remains usable when the standalone bridge is absent.
  onMount(() => {
    const project = desktopApi()?.project;
    if (!project) return;
    const refreshWorkerTasks = () => {
      void project.listWorkerTasks().then(records => setTaskOutcomes(records)).catch(error => logger.error("Could not restore worker outcomes", { error }));
    };
    void project.listWorkerTasks().then(records => setTaskOutcomes(records)).catch(error => logger.error("Could not load worker outcomes", { error }));
    const refreshProjectState = () => {
      void project.readState().then(state => {
        setDesktopProjectState(state);
        setProjectContextDraft(current => current === (desktopProjectState()?.context || "") ? (state.context || "") : current);
      }).catch(error => {
        setDesktopProjectNotice("Project memory could not be refreshed: " + getSdkErrorMessage(error));
      });
    };
    window.addEventListener("axiom-project-state-updated", refreshProjectState);
    window.addEventListener("axiom-worker-state-updated", refreshWorkerTasks);
    onCleanup(() => {
      window.removeEventListener("axiom-project-state-updated", refreshProjectState);
      window.removeEventListener("axiom-worker-state-updated", refreshWorkerTasks);
    });
    void project.readState().then(state => {
      setDesktopProjectState(state);
      setProjectContextDraft(state.context || "");
    }).catch(error => {
      setDesktopProjectNotice("Project memory could not be loaded: " + getSdkErrorMessage(error));
    });
    void loadProjectDirectory("");
  });

  const loadProjectDirectory = async (relativePath = projectFileDirectory()) => {
    const project = desktopApi()?.project;
    if (!project) return;
    setProjectFileBusy(true);
    setProjectFileNotice("");
    try {
      const entries = await project.listFiles(relativePath);
      setProjectFiles(entries);
      setProjectFileDirectory(relativePath);
    } catch (error) {
      setProjectFileNotice("Could not list project files: " + getSdkErrorMessage(error));
    } finally {
      setProjectFileBusy(false);
    }
  };

  const openProjectFile = async (relativePath: string) => {
    const project = desktopApi()?.project;
    if (!project) return;
    setProjectFileBusy(true);
    setProjectFileNotice("");
    try {
      const file = await project.readFile(relativePath);
      setSelectedProjectFile(file.path);
      setProjectFileContent(file.content);
      setProjectFileNotice("Loaded " + file.path + " (" + file.size.toLocaleString() + " bytes).");
    } catch (error) {
      setProjectFileNotice("Could not open file: " + getSdkErrorMessage(error));
    } finally {
      setProjectFileBusy(false);
    }
  };

  const saveProjectFile = async () => {
    const project = desktopApi()?.project;
    if (!project || !selectedProjectFile()) return;
    setProjectFileBusy(true);
    setProjectFileNotice("");
    try {
      const result = await project.writeFile(selectedProjectFile(), projectFileContent());
      setProjectFileNotice("Saved " + result.path + " (" + result.size.toLocaleString() + " bytes).");
      await loadProjectDirectory();
    } catch (error) {
      setProjectFileNotice("Could not save file: " + getSdkErrorMessage(error));
    } finally {
      setProjectFileBusy(false);
    }
  };

  const saveStandaloneProjectContext = async () => {
    const project = desktopApi()?.project;
    if (!project) {
      setDesktopProjectNotice("Persistent project memory is available in the Axiom desktop app.");
      return;
    }
    setDesktopProjectBusy(true);
    try {
      const state = await project.saveContext(projectContextDraft());
      setDesktopProjectState(state);
      setDesktopProjectNotice("Project context saved on this device.");
    } catch (error) {
      setDesktopProjectNotice("Could not save project context: " + getSdkErrorMessage(error));
    } finally {
      setDesktopProjectBusy(false);
    }
  };

  const recordLatestBuildOutcome = async () => {
    const project = desktopApi()?.project;
    if (!project) {
      setDesktopProjectNotice("The change feed is available in the Axiom desktop app.");
      return;
    }
    const outcomes = taskOutcomes();
    if (!outcomes.length) {
      setDesktopProjectNotice("There are no agent outcomes to record yet.");
      return;
    }
    setDesktopProjectBusy(true);
    try {
      const failed = outcomes.some(item => item.status === "failed");
      const active = outcomes.some(item => item.status === "running" || item.status === "queued");
      const state = await project.addChange({
        title: outcomes.length === 1 ? outcomes[0].title : "Agent run: " + outcomes.length + " tasks",
        summary: outcomes.map(item => item.title + " [" + item.status + "]" + (item.error ? ": " + item.error : item.summary ? ": " + item.summary : "")).join("\n").slice(0, 2000),
        status: failed ? "failed" : active ? "working" : "review",
        files: []
      });
      setDesktopProjectState(state);
      setDesktopProjectNotice("Build outcome added to the project change feed. Verification remains a separate step.");
    } catch (error) {
      setDesktopProjectNotice("Could not update the change feed: " + getSdkErrorMessage(error));
    } finally {
      setDesktopProjectBusy(false);
    }
  };

  const switchStandaloneProject = async () => {
    const project = desktopApi()?.project;
    if (!project) {
      setDesktopProjectNotice("Project switching is managed by the Axiom desktop host.");
      return;
    }
    const chosen = await project.chooseProject();
    if (chosen) {
      setDesktopProjectNotice("Switching project. Axiom will restart with the selected folder.");
    }
  };

  const createStandaloneProject = async () => {
    const project = desktopApi()?.project;
    if (!project) {
      setDesktopProjectNotice("Creating a project folder is available in the Axiom desktop app.");
      return;
    }
    try {
      const created = await project.createProject();
      if (created) setDesktopProjectNotice("Creating project. Axiom will restart with the new folder.");
    } catch (error) {
      setDesktopProjectNotice("Could not create project: " + getSdkErrorMessage(error));
    }
  };

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
    const text = withAxiomProjectContext(input().trim(), sync.workspaceRoot());
    if (!text || !sync.isReady()) {
      if (workflowRun()?.status === "running") {
        const message = !text ? "No prompt was available to run." : "Axiom is not connected to its local runtime.";
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
          const message = "The Axiom runtime did not return a new session.";
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
      
      const result = await sendPrompt(sessionId, withAxiomProjectContext(next.text, sync.workspaceRoot()), next.agent, extraParts, messageID);
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
      hostBridge.postMessage({ type: "agent-changed", agent });
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
            <p>{runtimeStatusMessage()}</p>
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

      <Show when={desktopApi()?.project}>
        <TerminalPanel />
      </Show>

      <Show when={desktopApi()?.project}>
        <section class="standalone-project-panel" aria-label="Standalone project workspace">
          <div class="standalone-project-panel__heading">
            <div>
              <span class="standalone-project-panel__eyebrow">PROJECT WORKSPACE</span>
              <strong>{desktopProjectState()?.workspaceRoot || sync.workspaceRoot() || "Current project"}</strong>
              <small>Persistent context stays on this device and is kept outside your repository.</small>
            </div>
            <button type="button" class="workflow-plan__secondary" onClick={() => void switchStandaloneProject()}>Choose project</button>
          </div>
          <div class="standalone-files">
            <div class="standalone-project-panel__feed-heading">
              <strong>Project files</strong>
              <div class="standalone-files__actions">
                <small>{projectFileDirectory() ? "/" + projectFileDirectory() : "/"}</small>
                <button type="button" class="workflow-plan__secondary" disabled={projectFileBusy()} onClick={() => void loadProjectDirectory(projectFileDirectory())}>Refresh</button>
                <button type="button" class="workflow-plan__secondary" disabled={projectFileBusy() || !projectFileDirectory()} onClick={() => void loadProjectDirectory(projectFileDirectory().split("/").slice(0, -1).join("/"))}>Up</button>
              </div>
            </div>
            <div class="standalone-files__layout">
              <ul class="standalone-files__list" aria-label="Project files">
                <Show when={projectFiles().length > 0} fallback={<li class="standalone-project-panel__empty">{projectFileBusy() ? "Loading files…" : "This directory is empty."}</li>}>
                  <For each={projectFiles()}>{entry => <li>
                    <button type="button" class={selectedProjectFile() === entry.path ? "standalone-files__entry is-selected" : "standalone-files__entry"} disabled={projectFileBusy() || entry.kind === "other"} onClick={() => entry.kind === "directory" ? void loadProjectDirectory(entry.path) : void openProjectFile(entry.path)}>
                      <span aria-hidden="true">{entry.kind === "directory" ? "▸" : "·"}</span>{entry.name}
                    </button>
                  </li>}</For>
                </Show>
              </ul>
              <div class="standalone-files__editor">
                <div class="standalone-files__editor-heading"><strong>{selectedProjectFile() || "Select a file to inspect"}</strong><button type="button" class="workflow-plan__primary" disabled={projectFileBusy() || !selectedProjectFile()} onClick={() => void saveProjectFile()}>{projectFileBusy() ? "Working…" : "Save file"}</button></div>
                <textarea aria-label="Selected project file contents" value={projectFileContent()} disabled={!selectedProjectFile() || projectFileBusy()} onInput={event => setProjectFileContent(event.currentTarget.value)} spellcheck={false} />
              </div>
            </div>
            <Show when={projectFileNotice()}><p class="standalone-project-panel__notice" role="status">{projectFileNotice()}</p></Show>
          </div>
          <label class="standalone-project-panel__label" for="axiom-project-context">Project instructions and durable context</label>
          <textarea id="axiom-project-context" value={projectContextDraft()} maxLength={50000} rows={3} placeholder="Architecture decisions, constraints, preferred commands, and project-specific conventions…" onInput={event => setProjectContextDraft(event.currentTarget.value)} />
          <div class="standalone-project-panel__actions">
            <small>{projectContextDraft().length.toLocaleString()} / 50,000 characters</small>
            <button type="button" class="workflow-plan__primary" disabled={desktopProjectBusy()} onClick={() => void saveStandaloneProjectContext()}>{desktopProjectBusy() ? "Saving…" : "Save project context"}</button>
          </div>
          <div class="standalone-project-panel__feed-heading">
            <strong>Recent change feed</strong>
            <button type="button" class="workflow-plan__secondary" disabled={desktopProjectBusy()} onClick={() => void recordLatestBuildOutcome()}>Record latest agent outcome</button>
          </div>
          <Show when={(desktopProjectState()?.changes.length || 0) > 0} fallback={<p class="standalone-project-panel__empty">No recorded changes yet. Record an agent outcome to start a project-level history.</p>}>
            <ol class="standalone-project-panel__feed">
              <For each={[...(desktopProjectState()?.changes || [])].reverse().slice(0, 6)}>{change => <li>
                <span class={"standalone-project-panel__status standalone-project-panel__status--" + change.status}>{change.status}</span>
                <div><strong>{change.title}</strong><p>{change.summary}</p><small>{new Date(change.createdAt).toLocaleString()}</small></div>
              </li>}</For>
            </ol>
          </Show>
          <Show when={desktopProjectNotice()}><p class="standalone-project-panel__notice" role="status">{desktopProjectNotice()}</p></Show>
        </section>
      </Show>

      <Show when={workflowRun()}>
        {(run) => (
          <section class={`workflow-run workflow-run--${run().status}`} aria-live="polite" aria-label="Build run status">
            <span class="workflow-run__indicator" aria-hidden="true" />
            <div class="workflow-run__copy">
              <strong>{run().status === "running" ? "Axiom is building" : run().status === "complete" ? "Response finished" : "Run needs attention"}</strong>
              <span>{run().status === "running" ? "Your plan was sent to the agent. Follow progress in the conversation." : run().status === "complete" ? "The agent response finished. This is not a quality-gate pass: review changed files and check results before accepting the work." : "The request did not complete successfully. Check the error in the conversation, then retry when ready."}</span>
            </div>
            <Show when={run().status === "running" && parallelAbortController()}>
              <button type="button" class="workflow-plan__secondary" onClick={() => parallelAbortController()?.abort(new Error("Cancelled by user"))}>Cancel parallel tasks</button>
            </Show>
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
            <span>{taskOutcomes().filter(item => item.status === "failed" || item.status === "timed_out").length} failed / timed out</span>
            <span>{taskOutcomes().filter(item => item.status === "blocked").length} blocked</span>
            <span>{taskOutcomes().filter(item => item.status === "cancelled").length} cancelled</span>
            <span>{taskOutcomes().filter(item => item.status === "queued" || item.status === "running").length} remaining</span>
          </div>
          <Show when={taskOutcomes().some(item => ["failed", "timed_out", "blocked"].includes(item.status))}>
            <button class="workflow-plan__secondary" disabled={parallelPlanBusy()} onClick={() => {
              const prompt = "Replan unfinished work from actual task outcomes. Preserve successful tasks, isolate failure causes, block only dependent tasks, and schedule unrelated remaining work. Do not repeat completed tasks unless a dependency or verification result requires it.\n\n" + taskOutcomes().map(item => "- " + item.title + " [" + item.status + "]: " + (item.error || item.summary || "No details reported")).join("\n");
              void prepareParallelPlan(prompt);
            }}>{parallelPlanBusy() ? "Replanning…" : "Replan failed and remaining work"}</button>
          </Show>
          <ol>
            <For each={taskOutcomes()}>{(task) => <li>
              <strong>{task.title}</strong>
              <span>{task.status === "succeeded" ? "AGENT SUCCEEDED · REVIEW REQUIRED" : task.status.toUpperCase()}{task.agent ? " · " + task.agent : ""}{task.sessionId ? " · " + task.sessionId : ""}</span>
              <Show when={task.worktreePath}><WorktreeReviewPanel taskId={task.taskId} worktreePath={task.worktreePath!} workspaceRoot={sync.workspaceRoot()} acceptanceCriteria={taskAcceptanceCriteria()[task.taskId] ?? []} onRepair={async failure => { if (!task.sessionId) throw new Error("No task session is available for a bounded repair."); await sendPrompt(task.sessionId, withAxiomProjectContext("Repair this task in its isolated worktree. Fix only the reported verification failures, preserve the task scope, and do not claim checks passed unless their exit status confirms it.\n\nFailure evidence:\n" + failure, sync.workspaceRoot()), task.agent); }} /></Show>
              <Show when={task.summary}><p>{task.summary}</p></Show>
              <Show when={typeof task.contextSavingsPercent === "number"}><p>Context compaction estimate: {task.contextEstimatedTokensBefore} → {task.contextEstimatedTokensAfter} tokens ({task.contextSavingsPercent}% estimated reduction)</p></Show>
              <Show when={task.error}><p>{task.error}</p></Show>
              <Show when={task.logs?.length}><details><summary>Worker logs and transcript ({task.logs!.length} entries)</summary><pre>{task.logs!.join("\n\n")}</pre></details></Show>
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
        <WelcomeScreen onSuggestion={(prompt) => setInput(prompt)} onOpenProject={() => void switchStandaloneProject()} onCreateProject={() => void createStandaloneProject()} />
        <ProviderReadinessPanel loadReadiness={getProviderReadiness} testConnection={testProviderConnection} />
        <ProviderOnboardingPanel />
        <OmniRouteSetupPanel />
        <McpIntegrationsPanel />
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
                <div class="workflow-plan__actions" aria-label="OmniRoute model routing">
                  <label>Planner model
                    <select value={requestedOmniRouteModel()} onChange={event => setRequestedOmniRouteModel(event.currentTarget.value)}>
                      <option value="">Auto-select first available</option>
                      <For each={omniRouteModels()}>{model => <option value={model.id}>{model.name} ({model.id})</option>}</For>
                    </select>
                  </label>
                  <label>Fallback model
                    <select value={fallbackOmniRouteModel()} onChange={event => setFallbackOmniRouteModel(event.currentTarget.value)}>
                      <option value="">No automatic fallback</option>
                      <For each={omniRouteModels().filter(model => model.id !== requestedOmniRouteModel())}>{model => <option value={model.id}>{model.name} ({model.id})</option>}</For>
                    </select>
                  </label>
                </div>
                <button class="workflow-plan__secondary" disabled={parallelPlanBusy()} onClick={() => void prepareParallelPlan()}>{parallelPlanBusy() ? "Planning tasks…" : "Plan with OmniRoute"}</button>
                <button class="workflow-plan__primary" onClick={() => void executeWorkflowPlan()}>Run this plan <span aria-hidden="true">→</span></button>
              </div>
              <Show when={parallelPlanError()}><RecoveryAdvice error={parallelPlanError()!} onRetry={prepareParallelPlan} /></Show>
              <Show when={parallelPlan()} keyed>
                {(parallel) => <div class="workflow-plan__parallel">
                  <p>OmniRoute selected <strong>{parallel.model}</strong> and proposed {parallel.tasks.length} tasks. Tasks with overlapping target files are scheduled sequentially.</p>
                  <Show when={parallel.routingExplanation}><p>{parallel.routingExplanation}</p></Show>
                  <Show when={parallel.fallbackUsed}><p role="status">An explicitly configured fallback model was used.</p></Show>
                  <Show when={parallel.discoveryWarning}><p role="status">{parallel.discoveryWarning}</p></Show>
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
              <div class="workflow-plan__eyebrow">ACCEPTANCE CHECKLIST</div>
              <ul class="workflow-acceptance-criteria">
                <For each={buildAcceptanceCriteria(plan.prompt)}>{(criterion) => <li>{criterion}</li>}</For>
              </ul>
              <div class="workflow-plan__actions">
                <button class="workflow-plan__secondary" onClick={() => setWorkflowPlan(null)}>Keep editing</button>
                <div class="workflow-plan__actions" aria-label="OmniRoute model routing">
                  <label>Planner model
                    <select value={requestedOmniRouteModel()} onChange={event => setRequestedOmniRouteModel(event.currentTarget.value)}>
                      <option value="">Auto-select first available</option>
                      <For each={omniRouteModels()}>{model => <option value={model.id}>{model.name} ({model.id})</option>}</For>
                    </select>
                  </label>
                  <label>Fallback model
                    <select value={fallbackOmniRouteModel()} onChange={event => setFallbackOmniRouteModel(event.currentTarget.value)}>
                      <option value="">No automatic fallback</option>
                      <For each={omniRouteModels().filter(model => model.id !== requestedOmniRouteModel())}>{model => <option value={model.id}>{model.name} ({model.id})</option>}</For>
                    </select>
                  </label>
                </div>
                <button class="workflow-plan__secondary" disabled={parallelPlanBusy()} onClick={() => void prepareParallelPlan()}>{parallelPlanBusy() ? "Planning tasks…" : "Plan with OmniRoute"}</button>
                <button class="workflow-plan__primary" onClick={() => void executeWorkflowPlan()}>Run this plan <span aria-hidden="true">→</span></button>
              </div>
              <Show when={parallelPlanError()}><RecoveryAdvice error={parallelPlanError()!} onRetry={prepareParallelPlan} /></Show>
              <Show when={parallelPlan()} keyed>
                {(parallel) => <div class="workflow-plan__parallel">
                  <p>OmniRoute selected <strong>{parallel.model}</strong> and proposed {parallel.tasks.length} tasks. Tasks with overlapping target files are scheduled sequentially.</p>
                  <Show when={parallel.routingExplanation}><p>{parallel.routingExplanation}</p></Show>
                  <Show when={parallel.fallbackUsed}><p role="status">An explicitly configured fallback model was used.</p></Show>
                  <Show when={parallel.discoveryWarning}><p role="status">{parallel.discoveryWarning}</p></Show>
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
