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
} from "./axiomRuntime";

describe("Axiom runtime helpers", () => {
  it("rejects planner tasks without explicit acceptance criteria", () => {
    expect(() => parseSubTasks([
      { id: "missing-criteria", title: "Task", scope: "Do work", targetFiles: ["src/task.ts"], dependsOn: [] },
    ])).toThrow(/explicit, non-empty acceptance criteria/);
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
    expect(outcomes).toEqual(["a:queued", "b:queued", "a:running", "a:succeeded", "b:running", "b:succeeded"]);
  });

  it("records failures and stops before dependent work", async () => {
    const tasks = parseSubTasks([
      { id: "a", title: "Fail", scope: "fail", targetFiles: ["a.ts"], dependsOn: [], acceptanceCriteria: ["Behavior is verified"] },
      { id: "b", title: "Blocked", scope: "blocked", targetFiles: ["b.ts"], dependsOn: ["a"], acceptanceCriteria: ["Behavior is verified"] },
    ]);
    const outcomes: string[] = [];
    await expect(executeTaskBatches(tasks, async task => {
      if (task.id === "a") throw new Error("agent unavailable");
      return "unexpected";
    }, record => outcomes.push(record.taskId + ":" + record.status))).rejects.toThrow(/agent unavailable/);
    expect(outcomes).toContain("a:failed");
    expect(outcomes).not.toContain("b:running");
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

  it("times out a task and passes an abort signal to the runner", async () => {
    const tasks = parseSubTasks([
      { id: "slow", title: "Slow", scope: "wait", targetFiles: ["slow.ts"], dependsOn: [], acceptanceCriteria: ["Timeout is surfaced"] },
    ]);
    let receivedSignal: AbortSignal | undefined;
    const outcomes: string[] = [];
    await expect(executeTaskBatches(tasks, async (_task, _completed, signal) => {
      receivedSignal = signal;
      return new Promise<string>(() => {});
    }, record => outcomes.push(record.status), { timeoutMs: 5 })).rejects.toThrow(/timed out after 5ms/);
    expect(receivedSignal?.aborted).toBe(true);
    expect(outcomes).toContain("timed_out");
  });

  it("stops waiting when the caller cancels task execution", async () => {
    const tasks = parseSubTasks([
      { id: "waiting", title: "Waiting", scope: "wait", targetFiles: ["waiting.ts"], dependsOn: [], acceptanceCriteria: ["Cancellation is surfaced"] },
    ]);
    const controller = new AbortController();
    const outcomes: string[] = [];
    const execution = executeTaskBatches(tasks, async () => new Promise<string>(() => {}), record => outcomes.push(record.status), { signal: controller.signal });
    controller.abort();
    await expect(execution).rejects.toThrow(/cancelled/i);
    expect(outcomes).toContain("cancelled");
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
});
