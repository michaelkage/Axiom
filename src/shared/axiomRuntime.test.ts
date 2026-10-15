import { describe, expect, it } from "vitest";
import {
  compressionPercent,
  createIndependentTasks,
  executeTaskBatches,
  parseSubTasks,
  planSubTasksWithOmniRoute,
} from "./axiomRuntime";

describe("Axiom runtime helpers", () => {
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

  it("reports compression only from measured token counts", () => {
    expect(compressionPercent(1000, 250)).toBe(75);
    expect(compressionPercent(0, 0)).toBeNull();
  });
});
