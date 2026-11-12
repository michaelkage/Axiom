import { describe, expect, it } from "vitest";
import {
  compressionPercent,
  discoverOmniRouteModels,
  resolveOmniRouteModel,
  createIndependentTasks,
  executeTaskBatches,
  TaskBatchExecutionError,
  parseSubTasks,
  planSubTasksWithOmniRoute,
  isCurrentTaskAttempt,
  isCurrentDispatchedTaskAttempt,
} from "./axiomRuntime";

describe("Axiom runtime helpers", () => {
  it("rejects callbacks from an earlier worker attempt while allowing the active attempt", () => {
    const attempts = new Map([["task-a", 2], ["task-b", 1]]);
    expect(isCurrentTaskAttempt("task-a", 1, attempts)).toBe(false);
    expect(isCurrentTaskAttempt("task-a", 2, attempts)).toBe(true);
    expect(isCurrentTaskAttempt("task-b", 1, attempts)).toBe(true);
    expect(isCurrentTaskAttempt("task-missing", 1, attempts)).toBe(false);
    expect(isCurrentTaskAttempt("task-a", undefined, attempts)).toBe(true);
  });
  it("requires dispatched callbacks to carry the current attempt generation", () => {
    const attempts = new Map([["task-a", 2], ["task-b", 1]]);
    expect(isCurrentDispatchedTaskAttempt("task-a", undefined, attempts)).toBe(false);
    expect(isCurrentDispatchedTaskAttempt("task-a", 1, attempts)).toBe(false);
    expect(isCurrentDispatchedTaskAttempt("task-a", 2, attempts)).toBe(true);
    expect(isCurrentDispatchedTaskAttempt("task-b", 1, attempts)).toBe(true);
    expect(isCurrentDispatchedTaskAttempt("task-missing", 1, attempts)).toBe(false);
  });

  it("rejects planner tasks without explicit acceptance criteria", () => {
    expect(() => parseSubTasks([
      { id: "missing-criteria", title: "Task", scope: "Do work", targetFiles: ["src/task.ts"], dependsOn: [] },
    ])).toThrow(/explicit, non-empty acceptance criteria/);
  });

  it("bounds planner output before it can expand worker fan-out or prompt size", () => {
    const base = { id: "bounded", title: "Task", scope: "Implement safely", targetFiles: ["src/task.ts"], dependsOn: [], acceptanceCriteria: ["Tests pass"] };
    expect(() => parseSubTasks(Array.from({ length: 51 }, (_, index) => ({ ...base, id: "task-" + index })))).toThrow(/more than 50 tasks/);
    expect(() => parseSubTasks([{ ...base, targetFiles: Array.from({ length: 101 }, (_, index) => "src/" + index + ".ts") }])).toThrow(/too many target files/);
    expect(() => parseSubTasks([{ ...base, targetFiles: Array.from({ length: 10_000 }, () => null) }])).toThrow(/too many target files/);
    expect(() => parseSubTasks([{ ...base, acceptanceCriteria: Array.from({ length: 21 }, () => "criterion") }])).toThrow(/concise, non-empty acceptance criteria/);
    expect(() => parseSubTasks([{ ...base, title: "x".repeat(241) }])).toThrow(/overlong title/);
  });

  it("rejects ambiguous normalized paths and malformed task identifiers", () => {
    const base = { id: "safe-task", title: "Task", scope: "Implement safely", targetFiles: ["src/task.ts"], dependsOn: [], acceptanceCriteria: ["Tests pass"] };
    expect(() => parseSubTasks([{ ...base, targetFiles: ["src/task.ts", "src\\task.ts"] }])).toThrow(/duplicate target paths/);
    expect(() => parseSubTasks([{ ...base, targetFiles: ["src//task.ts"] }])).toThrow(/unsafe workspace-relative target path/);
    expect(() => parseSubTasks([{ ...base, id: "../escape" }])).toThrow(/invalid or overlong ID/);
    expect(() => parseSubTasks([{ ...base, dependsOn: ["safe-task", "safe-task"] }])).toThrow(/duplicate dependency/);
  });

  it("serializes parent-directory and child-file write scopes", () => {
    const tasks = parseSubTasks([
      { id: "parent", title: "Parent", scope: "Own the source tree", targetFiles: ["src"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "child", title: "Child", scope: "Change one source file", targetFiles: ["src/app.tsx"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "independent", title: "Independent", scope: "Change unrelated file", targetFiles: ["docs/readme.md"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
    ]);
    expect(createIndependentTasks(tasks).map(batch => batch.map(task => task.id))).toEqual([["parent", "independent"], ["child"]]);
  });

  it("batches independent tasks and respects dependencies", () => {
    const tasks = parseSubTasks([
      { id: "a", title: "A", scope: "UI", targetFiles: ["App.tsx"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "b", title: "B", scope: "Tests", targetFiles: ["App.test.tsx"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "c", title: "C", scope: "Integrate", targetFiles: [], dependsOn: ["a", "b"], acceptanceCriteria: ["Behavior is verified"] },
    ]);
    expect(createIndependentTasks(tasks).map(batch => batch.map(task => task.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("serializes tasks with overlapping target files and parent-directory scopes", () => {
    const tasks = parseSubTasks([
      { id: "a", title: "A", scope: "A", targetFiles: ["src/App.tsx"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "b", title: "B", scope: "B", targetFiles: ["src/app.tsx"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "c", title: "C", scope: "C", targetFiles: ["src/Other.tsx"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
    ]);
    expect(createIndependentTasks(tasks).map(batch => batch.map(task => task.id))).toEqual([["a", "c"], ["b"]]);
  });

  it("rejects unknown dependencies and cycles", () => {
    expect(() => parseSubTasks([{ id: "a", title: "A", scope: "x", targetFiles: [], dependsOn: ["missing"], acceptanceCriteria: ["Behavior is verified"] }])).toThrow(/Unknown dependency/);
    expect(() => createIndependentTasks([
      { id: "a", title: "A", scope: "x", targetFiles: [], dependsOn: ["b"], acceptanceCriteria: ["Behavior is verified"] },
      { id: "b", title: "B", scope: "x", targetFiles: [], dependsOn: ["a"], acceptanceCriteria: ["Behavior is verified"] },
    ])).toThrow(/dependency cycle/);
  });

  it("serializes tasks that do not declare target files", () => {
    const tasks = parseSubTasks([
      { id: "unknown", title: "Unknown scope", scope: "inspect and change", targetFiles: [], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "known", title: "Known scope", scope: "change", targetFiles: ["src/known.ts"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
    ]);
    expect(createIndependentTasks(tasks).map(batch => batch.map(task => task.id))).toEqual([["unknown"], ["known"]]);
  });

  it("rejects empty plans and unsafe target paths", () => {
    expect(() => parseSubTasks([])).toThrow(/empty task list/);
    expect(() => parseSubTasks([
      { id: "escape", title: "Escape", scope: "x", targetFiles: ["../outside.ts"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
    ])).toThrow(/unsafe workspace-relative target path/);
  });

  it("retries only transient failures and records the successful attempt", async () => {
    const tasks = parseSubTasks([
      { id: "retry", title: "Retry", scope: "transient failure", targetFiles: ["retry.ts"], dependsOn: [], acceptanceCriteria: ["Eventually succeeds"] },
    ]);
    let calls = 0;
    const outcomes: Array<{ status: string; attempt?: number }> = [];
    const result = await executeTaskBatches(tasks, async () => {
      calls++;
      if (calls === 1) throw new Error("ECONNRESET: connection reset");
      return "recovered";
    }, record => outcomes.push(record), { maxRetries: 1 });
    expect(result[0]?.result).toBe("recovered");
    expect(calls).toBe(2);
    expect(outcomes.filter(item => item.status === "running").map(item => item.attempt)).toEqual([undefined, 1, 1, 2]);
    expect(outcomes.find(item => item.status === "succeeded")?.attempt).toBe(2);
  });

  it("enforces a total execution-attempt budget across tasks", async () => {
    const tasks = parseSubTasks(["a", "b"].map(id => ({
      id, title: id, scope: "budget", targetFiles: [id + ".ts"], dependsOn: [], acceptanceCriteria: ["Budget enforced"],
    })));
    let calls = 0;
    await expect(executeTaskBatches(tasks, async () => { calls++; return "ok"; }, undefined, { maxTotalAttempts: 1 })).rejects.toThrow(/attempt budget exhausted/);
    expect(calls).toBe(1);
  });

  it("caps concurrent workers while allowing the rest of a safe batch to finish", async () => {
    const tasks = parseSubTasks(["a", "b", "c", "d", "e"].map(id => ({
      id, title: id.toUpperCase(), scope: "independent", targetFiles: [id + ".ts"], dependsOn: [], acceptanceCriteria: ["Task completes"],
    })));
    let active = 0;
    let peak = 0;
    await executeTaskBatches(tasks, async task => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 8));
      active--;
      return task.id;
    }, undefined, { maxConcurrency: 2 });
    expect(peak).toBe(2);
    expect(active).toBe(0);
  });

  it("executes safe batches concurrently and waits between dependency layers", async () => {
    const order: string[] = [];
    const tasks = parseSubTasks([
      { id: "a", title: "A", scope: "x", targetFiles: ["a.ts"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "b", title: "B", scope: "x", targetFiles: ["b.ts"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "c", title: "C", scope: "x", targetFiles: ["c.ts"], dependsOn: ["a", "b"], acceptanceCriteria: ["Behavior is verified"] },
    ]);
    const result = await executeTaskBatches(tasks, async task => {
      order.push(task.id);
      return task.id.toUpperCase();
    });
    expect(result.map(item => item.result)).toEqual(["A", "B", "C"]);
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
  });

  it("emits task lifecycle outcomes and supplies completed task context to dependent batches", async () => {
    const tasks = parseSubTasks([
      { id: "a", title: "Research", scope: "research", targetFiles: ["a.ts"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "b", title: "Implement", scope: "implement from research", targetFiles: ["b.ts"], dependsOn: ["a"], acceptanceCriteria: ["Behavior is verified"] },
    ]);
    const outcomes: string[] = [];
    const result = await executeTaskBatches(tasks, async (task, completed) => {
      if (task.id === "b") expect(completed.map(item => item.task.id)).toEqual(["a"]);
      return { sessionId: task.id + "-session" };
    }, record => outcomes.push(record.taskId + ":" + record.status));
    expect(result).toHaveLength(2);
    expect(outcomes).toEqual(["a:queued", "b:queued", "a:running", "a:running", "a:succeeded", "b:running", "b:running", "b:succeeded"]);
  });

  it("terminalizes queued tasks when a failed batch prevents later work", async () => {
    const tasks = parseSubTasks([
      { id: "a", title: "Fail", scope: "fail", targetFiles: ["shared.ts"], dependsOn: [], acceptanceCriteria: ["Failure is reported"] },
      { id: "b", title: "Queued writer", scope: "writes the same file later", targetFiles: ["shared.ts"], dependsOn: [], acceptanceCriteria: ["Does not run after earlier failure"] },
      { id: "c", title: "Dependent", scope: "depends on failed task", targetFiles: ["dependent.ts"], dependsOn: ["a"], acceptanceCriteria: ["Is blocked"] },
    ]);
    const outcomes: Array<{ taskId: string; status: string; error?: string }> = [];
    let failure: unknown;
    try {
      await executeTaskBatches(tasks, async task => {
        if (task.id === "a") throw new Error("agent unavailable");
        return "unexpected";
      }, record => outcomes.push(record));
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TaskBatchExecutionError);
    expect((failure as TaskBatchExecutionError).blockedTaskIds).toEqual(expect.arrayContaining(["b", "c"]));
    expect((failure as TaskBatchExecutionError).failedTaskIds).toContain("a");
    expect(outcomes.filter(record => record.taskId === "a").at(-1)?.status).toBe("failed");
    expect(outcomes.filter(record => record.taskId === "b").at(-1)).toMatchObject({
      status: "blocked", error: "Not started because another task in the plan failed.",
    });
    expect(outcomes.filter(record => record.taskId === "c").at(-1)?.status).toBe("blocked");
    expect(outcomes.some(record => record.taskId === "b" && record.status === "running")).toBe(false);
  });

  it("preserves successful peer results and reports blocked dependents after a worker fails", async () => {
    const tasks = parseSubTasks([
      { id: "good", title: "Good", scope: "independent", targetFiles: ["good.ts"], dependsOn: [], acceptanceCriteria: ["Result is returned"] },
      { id: "bad", title: "Bad", scope: "independent", targetFiles: ["bad.ts"], dependsOn: [], acceptanceCriteria: ["Error is reported"] },
      { id: "downstream", title: "Downstream", scope: "depends on bad", targetFiles: ["downstream.ts"], dependsOn: ["bad"], acceptanceCriteria: ["Does not run after failure"] },
    ]);
    let failure: unknown;
    const outcomes: string[] = [];
    try {
      await executeTaskBatches(tasks, async task => {
        if (task.id === "bad") throw new Error("worker exploded");
        return { value: task.id };
      }, record => outcomes.push(record.taskId + ":" + record.status));
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(TaskBatchExecutionError);
    expect((failure as TaskBatchExecutionError).successfulResults.map(item => item.task.id)).toContain("good");
    expect((failure as TaskBatchExecutionError).failedTaskIds).toContain("bad");
    expect((failure as TaskBatchExecutionError).blockedTaskIds).toContain("downstream");
    expect(outcomes).toContain("downstream:blocked");
  });

  it("preserves worker identity, logs, and context metrics when a worker fails", async () => {
    const tasks = parseSubTasks([
      { id: "worker", title: "Worker session", scope: "execute in isolated session", targetFiles: ["worker.ts"], dependsOn: [], acceptanceCriteria: ["Failure diagnostics are complete"] },
    ]);
    const outcomes: Array<Record<string, unknown>> = [];
    await expect(executeTaskBatches(tasks, async () => {
      throw Object.assign(new Error("provider disconnected"), {
        sessionId: "session-failed",
        worktreePath: "/tmp/axiom-worktree",
        agent: "builder",
        summary: "Edited two files before provider disconnected",
        contextEstimatedTokensBefore: 2400,
        contextEstimatedTokensAfter: 900,
        contextSavingsPercent: 62.5,
        logs: ["session created", "patch applied", "provider disconnected"],
      });
    }, record => outcomes.push(record as unknown as Record<string, unknown>))).rejects.toThrow(/provider disconnected/);

    expect(outcomes.find(record => record.status === "failed")).toMatchObject({
      taskId: "worker", status: "failed", error: "provider disconnected",
      sessionId: "session-failed", worktreePath: "/tmp/axiom-worktree", agent: "builder",
      summary: "Edited two files before provider disconnected",
      contextEstimatedTokensBefore: 2400, contextEstimatedTokensAfter: 900,
      contextSavingsPercent: 62.5,
      logs: ["session created", "patch applied", "provider disconnected"],
    });
  });

  it("times out a task and passes an abort signal to the runner", async () => {
    const tasks = parseSubTasks([
      { id: "slow", title: "Slow", scope: "wait", targetFiles: ["slow.ts"], dependsOn: [], acceptanceCriteria: ["Timeout is surfaced"] },
    ]);
    let receivedSignal: AbortSignal | undefined;
    const outcomes: string[] = [];
    await expect(executeTaskBatches(tasks, async (_task, _completed, signal) => {
      receivedSignal = signal;
      return new Promise<string>(() => {});
    }, record => outcomes.push(record.status), { timeoutMs: 5, abortDrainTimeoutMs: 5 })).rejects.toThrow(/timed out after 5ms/);
    expect(receivedSignal?.aborted).toBe(true);
    expect(outcomes).toContain("timed_out");
  });

  it("waits for an aborted runner to settle before releasing its worker slot", async () => {
    const tasks = parseSubTasks([
      { id: "abort-drain", title: "Abort drain", scope: "cancellation", targetFiles: ["abort-drain.ts"], dependsOn: [], acceptanceCriteria: ["Abort cleanup settles before slot release"] },
    ]);
    const controller = new AbortController();
    let settled = false;
    const outcomes: string[] = [];
    const execution = executeTaskBatches(tasks, async (_task, _completed, signal) => new Promise<string>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        setTimeout(() => {
          settled = true;
          reject(new Error("remote abort completed"));
        }, 15);
      }, { once: true });
    }), record => outcomes.push(record.status), { signal: controller.signal, abortDrainTimeoutMs: 100 });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(execution).rejects.toThrow(/cancelled/i);
    expect(settled).toBe(true);
    expect(outcomes).toContain("cancelled");
  });

  it("quarantines a runner whose abort does not settle before the cleanup deadline", async () => {
    const tasks = parseSubTasks([
      { id: "unconfirmed-abort", title: "Unconfirmed abort", scope: "cancellation", targetFiles: ["unconfirmed.ts"], dependsOn: [], acceptanceCriteria: ["Unconfirmed remote work is quarantined"] },
    ]);
    const controller = new AbortController();
    const outcomes: string[] = [];
    const execution = executeTaskBatches(tasks, async () => new Promise<string>(() => {}), record => outcomes.push(record.status), {
      signal: controller.signal,
      abortDrainTimeoutMs: 5,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(execution).rejects.toThrow(/abort was not confirmed/i);
    expect(outcomes).toContain("timed_out");
  });

  it("persists late session and worktree diagnostics after quarantining an unresponsive worker", async () => {
    const tasks = parseSubTasks([
      { id: "late-diagnostics", title: "Late diagnostics", scope: "finish startup cleanup", targetFiles: ["late.ts"], dependsOn: [], acceptanceCriteria: ["Late worker metadata remains visible"] },
    ]);
    const controller = new AbortController();
    const outcomes: Array<Record<string, unknown>> = [];
    const execution = executeTaskBatches(tasks, async () => new Promise(resolve => {
      setTimeout(() => resolve({
        sessionId: "late-child-session",
        worktreePath: "/tmp/axiom-late-worktree",
        logs: ["child session eventually returned"],
      }), 25);
    }), record => outcomes.push(record as unknown as Record<string, unknown>), {
      signal: controller.signal,
      abortDrainTimeoutMs: 5,
    });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(execution).rejects.toThrow(/abort was not confirmed/i);
    expect(outcomes.find(record => record.status === "timed_out")).toMatchObject({ taskId: "late-diagnostics" });
    await new Promise(resolve => setTimeout(resolve, 35));
    const lateRecords = outcomes.filter(record => record.status === "timed_out");
    const late = lateRecords[lateRecords.length - 1];
    expect(late).toMatchObject({
      taskId: "late-diagnostics",
      sessionId: "late-child-session",
      worktreePath: "/tmp/axiom-late-worktree",
      logs: ["child session eventually returned"],
    });
  });

  it("cancels workers queued for a concurrency slot without starting them", async () => {
    const tasks = parseSubTasks(["first", "second"].map(id => ({
      id, title: id, scope: "independent", targetFiles: [id + ".ts"], dependsOn: [], acceptanceCriteria: ["Queued work cancels promptly"],
    })));
    const controller = new AbortController();
    const started: string[] = [];
    const outcomes: Array<{ taskId: string; status: string }> = [];
    const execution = executeTaskBatches(tasks, async task => {
      started.push(task.id);
      return new Promise<string>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(new Error("runner cancelled")), { once: true });
      });
    }, record => outcomes.push({ taskId: record.taskId, status: record.status }), { signal: controller.signal, maxConcurrency: 1 });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await expect(execution).rejects.toThrow(/cancelled/i);
    expect(started).toEqual(["first"]);
    expect(outcomes.find(item => item.taskId === "second" && item.status === "cancelled")).toBeTruthy();
  });

  it("stops waiting when the caller cancels task execution", async () => {
    const tasks = parseSubTasks([
      { id: "waiting", title: "Waiting", scope: "wait", targetFiles: ["waiting.ts"], dependsOn: [], acceptanceCriteria: ["Cancellation is surfaced"] },
    ]);
    const controller = new AbortController();
    const outcomes: string[] = [];
    const execution = executeTaskBatches(tasks, async () => new Promise<string>(() => {}), record => outcomes.push(record.status), { signal: controller.signal, abortDrainTimeoutMs: 5 });
    controller.abort();
    await expect(execution).rejects.toThrow(/abort was not confirmed/i);
    expect(outcomes).toContain("timed_out");
  });

  it("plans tasks through an OpenAI-compatible OmniRoute endpoint", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("test-model");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ tasks: [
          { id: "ui", title: "Update UI", scope: "Update the panel", targetFiles: ["src/App.tsx"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
        ] }) } }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const tasks = await planSubTasksWithOmniRoute("Add a panel", "test-model", {
      gatewayUrl: "http://127.0.0.1:20128/v1",
      nativeOmniRoute: true, enableSubAgents: true, errorHealing: "notify",
      requestTimeoutMs: 1000, maxAutomaticRetries: 0,
    }, fetcher);
    expect(tasks[0]?.title).toBe("Update UI");
  });

  it("discovers OmniRoute models and distinguishes reachable from unavailable gateway", async () => {
    const config = { gatewayUrl: "http://127.0.0.1:20128/v1", nativeOmniRoute: true, enableSubAgents: true, errorHealing: "notify" as const, requestTimeoutMs: 100, maxAutomaticRetries: 0 };
    const result = await discoverOmniRouteModels(config, async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:20128/v1/models");
      expect(init?.method).toBe("GET");
      return new Response(JSON.stringify({ data: [{ id: "local/qwen", name: "Qwen Local" }, { id: "cloud/fast" }] }), { status: 200 });
    });
    expect(result.reachable).toBe(true);
    expect(result.models).toEqual([{ id: "local/qwen", name: "Qwen Local" }, { id: "cloud/fast", name: "cloud/fast" }]);
    const offline = await discoverOmniRouteModels(config, async () => { throw new Error("ECONNREFUSED"); });
    expect(offline.reachable).toBe(false);
    expect(offline.warning).toContain("local Axiom runtime");
  });

  it("reports explicit fallback selection instead of silently changing models", () => {
    const inventory = [{ id: "local/qwen", name: "Qwen" }];
    expect(resolveOmniRouteModel("missing/model", inventory)).toEqual({
      model: null, fallbackUsed: false,
      explanation: "Requested model missing/model is not in the discovered inventory; no usable fallback was configured.",
    });
    expect(resolveOmniRouteModel("missing/model", inventory, "local/qwen")).toEqual({
      model: "local/qwen", fallbackUsed: true,
      explanation: "Requested model missing/model was unavailable; explicitly configured fallback local/qwen was selected.",
    });
  });

  it("reports compression only from measured token counts", () => {
    expect(compressionPercent(1000, 250)).toBe(75);
    expect(compressionPercent(0, 0)).toBeNull();
  });
  it("preserves isolated worktree diagnostics when child-session startup fails", async () => {
    const tasks = parseSubTasks([
      { id: "startup-failure", title: "Start child session", scope: "create a child session", targetFiles: ["startup.ts"], dependsOn: [], acceptanceCriteria: ["Retain the isolated worktree path"] },
    ]);
    const outcomes: Array<Record<string, unknown>> = [];
    const failure = Object.assign(new Error("Could not create child session: runtime unavailable"), {
      worktreePath: "/tmp/axiom-startup-failure",
      logs: ["isolated worktree created"],
    });
    await expect(executeTaskBatches(tasks, async () => { throw failure; }, record => {
      outcomes.push(record as unknown as Record<string, unknown>);
    })).rejects.toThrow(/runtime unavailable/);
    expect(outcomes.find(record => record.status === "failed")).toMatchObject({
      taskId: "startup-failure",
      status: "failed",
      worktreePath: "/tmp/axiom-startup-failure",
      logs: ["isolated worktree created"],
    });
  });

  it("preserves session and worktree diagnostics when a worker prompt fails", async () => {
    const tasks = parseSubTasks([
      { id: "prompt-failure", title: "Execute worker prompt", scope: "run the task prompt", targetFiles: ["prompt.ts"], dependsOn: [], acceptanceCriteria: ["Retain session diagnostics"] },
    ]);
    const outcomes: Array<Record<string, unknown>> = [];
    const failure = Object.assign(new Error("Provider rejected the prompt"), {
      sessionId: "child-session-42",
      worktreePath: "/tmp/axiom-prompt-failure",
      agent: "builder",
      logs: ["session created", "prompt submitted"],
    });
    await expect(executeTaskBatches(tasks, async () => { throw failure; }, record => {
      outcomes.push(record as unknown as Record<string, unknown>);
    })).rejects.toThrow(/Provider rejected/);
    expect(outcomes.find(record => record.status === "failed")).toMatchObject({
      taskId: "prompt-failure",
      status: "failed",
      sessionId: "child-session-42",
      worktreePath: "/tmp/axiom-prompt-failure",
      agent: "builder",
      logs: ["session created", "prompt submitted"],
    });
  });

  it("forwards worker session metadata and transcript into the terminal outcome", async () => {
    const tasks = parseSubTasks([
      { id: "worker", title: "Worker session", scope: "execute in isolated session", targetFiles: ["worker.ts"], dependsOn: [], acceptanceCriteria: ["Session metadata is surfaced"] },
    ]);
    const outcomes: Array<Record<string, unknown>> = [];
    await executeTaskBatches(tasks, async () => ({
      sessionId: "session-123", worktreePath: "/tmp/axiom-worktree", agent: "builder", summary: "Implemented the change", logs: ["opened session", "finished edit"],
    }), record => outcomes.push(record as unknown as Record<string, unknown>));
    const terminal = outcomes.find(record => record.status === "succeeded");
    expect(terminal).toMatchObject({
      taskId: "worker", status: "succeeded", sessionId: "session-123",
      worktreePath: "/tmp/axiom-worktree", agent: "builder", summary: "Implemented the change",
      logs: ["opened session", "finished edit"],
    });
  });

});
