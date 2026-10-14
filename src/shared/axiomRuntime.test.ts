import { describe, expect, it } from "vitest";
import { compressionPercent, createIndependentTasks, parseSubTasks } from "./axiomRuntime";
describe("Axiom runtime helpers", () => {
  it("batches independent tasks and respects dependencies", () => {
    const tasks = parseSubTasks([{ id: "a", title: "A", scope: "UI", targetFiles: ["App.tsx"], dependsOn: [] }, { id: "b", title: "B", scope: "Tests", targetFiles: ["App.test.tsx"], dependsOn: [] }, { id: "c", title: "C", scope: "Integrate", targetFiles: [], dependsOn: ["a", "b"] }]);
    expect(createIndependentTasks(tasks).map(batch => batch.map(task => task.id))).toEqual([["a", "b"], ["c"]]);
  });
  it("rejects cycles and unknown dependencies", () => {
    expect(() => parseSubTasks([{ id: "a", title: "A", scope: "x", targetFiles: [], dependsOn: ["missing"] }])).toThrow(/Unknown dependency/);
  });
  it("reports compression only from measured token counts", () => {
    expect(compressionPercent(1000, 250)).toBe(75);
    expect(compressionPercent(0, 0)).toBeNull();
  });
});
