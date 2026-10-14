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
      { id: "a", title: "A", scope: "UI", targetFiles: ["App.tsx"], dependsOn: [] },
      { id: "b", title: "B", scope: "Tests", targetFiles: ["App.test.tsx"], dependsOn: [] },
      { id: "c", title: "C", scope: "Integrate", targetFiles: [], dependsOn: ["a", "b"] },
    ]);
    expect(createIndependentTasks(tasks).map(batch => batch.map(task => task.id))).toEqual([["a", "b"], ["c"]]);
  });

  it("serializes tasks with overlapping target files", () => {
    const tasks = parseSubTasks([
      { id: "a", title: "A", scope: "A", targetFiles: ["src/App.tsx"], dependsOn: [] },
      { id: "b", title: "B", scope: "B", targetFiles: ["src/app.tsx"], dependsOn: [] },
      { id: "c", title: "C", scope: "C", targetFiles: ["src/Other.tsx"], dependsOn: [] },
    ]);
    expect(createIndependentTasks(tasks).map(batch => batch.map(task => task.id))).toEqual([["a", "c"], ["b"]]);
  });

  it("rejects unknown dependencies and cycles", () => {
    expect(() => parseSubTasks([{ id: "a", title: "A", scope: "x", targetFiles: [], dependsOn: ["missing"] }])).toThrow(/Unknown dependency/);
    expect(() => createIndependentTasks([
      { id: "a", title: "A", scope: "x", targetFiles: [], dependsOn: ["b"] },
      { id: "b", title: "B", scope: "x", targetFiles: [], dependsOn: ["a"] },
    ])).toThrow(/dependency cycle/);
  });

  it("rejects empty plans and unsafe target paths", () => {
    expect(() => parseSubTasks([])).toThrow(/empty task list/);
    expect(() => parseSubTasks([
      { id: "escape", title: "Escape", scope: "x", targetFiles: ["../outside.ts"], dependsOn: [] },
    ])).toThrow(/unsafe workspace-relative target path/);
  });

  it("executes safe batches concurrently and waits between dependency layers", async () => {
    const order: string[] = [];
    const tasks = parseSubTasks([
      { id: "a", title: "A", scope: "x", targetFiles: ["a.ts"], dependsOn: [] },
      { id: "b", title: "B", scope: "x", targetFiles: ["b.ts"], dependsOn: [] },
      { id: "c", title: "C", scope: "x", targetFiles: ["c.ts"], dependsOn: ["a", "b"] },
    ]);
    const result = await executeTaskBatches(tasks, async task => {
      order.push(task.id);
      return task.id.toUpperCase();
    });
    expect(result.map(item => item.result)).toEqual(["A", "B", "C"]);
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("a"));
    expect(order.indexOf("c")).toBeGreaterThan(order.indexOf("b"));
  });

  it("plans tasks through an OpenAI-compatible OmniRoute endpoint", async () => {
    const fetcher: typeof fetch = async (_input, init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("test-model");
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ tasks: [
          { id: "ui", title: "Update UI", scope: "Update the panel", targetFiles: ["src/App.tsx"], dependsOn: [] },
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
