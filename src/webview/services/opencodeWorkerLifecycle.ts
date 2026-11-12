export interface OpenCodeWorkerLifecycleTask {
  id: string;
  title: string;
}

export interface OpenCodeWorkerLifecycleResult {
  sessionId: string;
  taskId: string;
  title: string;
  agent?: string;
  summary: string;
  worktreePath: string;
  logs: string[];
}

export interface OpenCodeWorkerLifecycleOptions {
  task: OpenCodeWorkerLifecycleTask;
  parentSessionId: string;
  workspaceRoot: string;
  buildPrompt: (worktreePath: string) => string;
  agent?: string;
  diagnostics?: Record<string, number>;
  signal?: AbortSignal;
  createWorktree: (taskId: string, workspaceRoot: string) => Promise<string>;
  createSession: (input: { directory: string; parentID: string; title: string }) => Promise<{
    data?: { id?: string };
    error?: unknown;
  }>;
  promptSession: (input: { sessionID: string; parts: Array<{ type: "text"; text: string }>; agent?: string }) => Promise<{ error?: unknown }>;
  abortSession: (sessionId: string) => Promise<unknown>;
  getMessages: (sessionId: string) => Promise<{
    data?: Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>;
  }>;
  subscribe: (onEvent: (event: unknown) => void, directory: string) => () => void;
  onLog?: (taskId: string, line: string) => void;
  now?: () => Date;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export async function runOpenCodeWorkerLifecycle(
  options: OpenCodeWorkerLifecycleOptions,
): Promise<OpenCodeWorkerLifecycleResult> {
  const { task, parentSessionId, workspaceRoot, signal } = options;
  if (signal?.aborted) throw new Error("Parallel task cancelled before worker startup.");

  const worktreePath = await options.createWorktree(task.id, workspaceRoot);
  if (signal?.aborted) {
    throw Object.assign(new Error("Parallel task cancelled after worktree setup."), { worktreePath });
  }

  let created: Awaited<ReturnType<typeof options.createSession>>;
  try {
    created = await options.createSession({
      directory: worktreePath,
      parentID: parentSessionId,
      title: "Axiom: " + task.title,
    });
  } catch (error) {
    throw Object.assign(
      new Error('Could not create child session for "' + task.title + '": ' + errorMessage(error).slice(0, 1000)),
      { worktreePath },
    );
  }
  if (created.error || !created.data?.id) {
    throw Object.assign(
      new Error('Could not create child session for "' + task.title + '": ' +
        (created.error ? errorMessage(created.error).slice(0, 1000) : "missing session ID")),
      { worktreePath },
    );
  }

  const sessionId = created.data.id;
  const logs: string[] = [];
  const log = (line: string) => {
    const entry = (options.now?.() ?? new Date()).toISOString() + " " + line.slice(0, 1800);
    logs.push(entry);
    if (logs.length > 200) logs.shift();
    try {
      options.onLog?.(task.id, entry);
    } catch {
      // Observers must not be able to interrupt worker execution.
    }
  };
  log("Worker session created: " + sessionId);
  log("Isolated worktree: " + worktreePath);

  const taskError = (message: string) => Object.assign(new Error(message), {
    sessionId,
    worktreePath,
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.diagnostics ?? {}),
    logs: logs.slice(),
  });

  let abortPromise: Promise<unknown> | undefined;
  const abortWorker = () => {
    abortPromise ??= Promise.resolve().then(() => options.abortSession(sessionId)).catch(() => undefined);
    return abortPromise;
  };

  const stopEvents = (() => {
    try {
    return options.subscribe(event => {
    let serialized: string;
    try {
      const encoded = JSON.stringify(event);
      if (typeof encoded !== "string") return;
      serialized = encoded;
    } catch {
      return;
    }
    if (!serialized.includes(sessionId)) return;
    const type = String((event as { type?: unknown } | null)?.type ?? "runtime.event");
    if (!/message\.|session\.(error|status|idle|updated)|tool\./.test(type)) return;
    log("[" + type + "] " + serialized.slice(0, 1400));
  }, worktreePath);
    } catch (error) {
      log("Worker event subscription unavailable: " + errorMessage(error));
      return () => undefined;
    }
  })();

  const cleanupPrompt = () => {
    signal?.removeEventListener("abort", abortWorker);
    try {
      stopEvents();
    } catch {
      // Cleanup failures must not mask the worker outcome.
    }
  };

  if (signal?.aborted) {
    try {
      await abortWorker();
    } finally {
      cleanupPrompt();
    }
    throw taskError("Parallel task cancelled before prompting the worker.");
  }

  signal?.addEventListener("abort", abortWorker, { once: true });
  let promptResult: { error?: unknown };
  try {
    promptResult = await options.promptSession({
      sessionID: sessionId,
      parts: [{ type: "text", text: options.buildPrompt(worktreePath) }],
      ...(options.agent ? { agent: options.agent } : {}),
    });
  } catch (error) {
    if (signal?.aborted) await abortWorker();
    throw taskError(errorMessage(error));
  } finally {
    if (signal?.aborted) await abortWorker();
    cleanupPrompt();
  }

  log("Worker prompt completed.");
  if (signal?.aborted) throw taskError("Parallel task was cancelled while the worker was running.");
  if (promptResult.error) throw taskError('Task "' + task.title + '" failed: ' + errorMessage(promptResult.error));

  let summary = "Agent prompt was accepted; review workspace changes and verification before merging.";
  if (signal?.aborted) throw taskError("Parallel task was cancelled before collecting the worker transcript.");
  signal?.addEventListener("abort", abortWorker, { once: true });
  try {
    const response = await options.getMessages(sessionId);
    const messages = response.data ?? [];
    const assistantMessages = messages.filter(message => message.info?.role === "assistant");
    const latest = assistantMessages[assistantMessages.length - 1];
    const transcript = (latest?.parts ?? [])
      .filter(part => part.type === "text" && typeof part.text === "string")
      .map(part => part.text)
      .join("\n")
      .trim();
    if (transcript) {
      summary = transcript.slice(0, 1200);
      log("Assistant transcript: " + transcript.slice(0, 12000));
    }
  } catch {
    // Transcript retrieval is diagnostic; a successful prompt remains successful.
  } finally {
    if (signal?.aborted) await abortWorker();
    signal?.removeEventListener("abort", abortWorker);
  }

  return { sessionId, taskId: task.id, title: task.title, ...(options.agent ? { agent: options.agent } : {}),
    summary, worktreePath, logs: logs.slice() };
}
