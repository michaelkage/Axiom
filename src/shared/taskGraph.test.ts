import { describe, expect, it } from "vitest";
import { analyzeTaskGraph, getFailureImpact, selectRunnableTaskBatch, type TaskGraphNode } from "./taskGraph";
const task = (id: string, files: string[], dependsOn: string[] = [], status: TaskGraphNode["status"] = "queued"): TaskGraphNode =>
  ({ id, title: id, scope: id, targetFiles: files, dependsOn, acceptanceCriteria: ["Verified"], status });

describe("dynamic task graph intelligence", () => {
  it("builds deterministic topological layers and ready work", () => {
    const graph = [task("c", ["c.ts"], ["a", "b"]), task("b", ["b.ts"]), task("a", ["a.ts"])];
    expect(analyzeTaskGraph(graph)).toMatchObject({ valid: true, topologicalOrder: ["a", "b", "c"], readyTaskIds: ["a", "b"], layers: [["a", "b"], ["c"]] });
  });
  it("detects missing dependencies, duplicate edges, cycles and unsafe scopes", () => {
    expect(analyzeTaskGraph([task("a", ["a.ts"], ["missing"])]).issues[0].code).toBe("unknown-dependency");
    expect(analyzeTaskGraph([task("a", ["a.ts"], ["b"]), task("b", ["b.ts"], ["a"])]).issues[0].code).toBe("cycle");
    expect(analyzeTaskGraph([task("a", ["../escape"])]).valid).toBe(false);
    expect(analyzeTaskGraph([task("a", ["a.ts"], ["b", "b"]), task("b", ["b.ts"])]).valid).toBe(false);
  });
  it("only releases tasks whose dependencies have succeeded", () => {
    const graph = [task("a", ["a.ts"], [], "succeeded"), task("b", ["b.ts"], ["a"]), task("c", ["c.ts"], ["a"], "failed"), task("d", ["d.ts"], ["c"])];
    expect(analyzeTaskGraph(graph)).toMatchObject({ readyTaskIds: ["b"], blockedTaskIds: ["d"] });
  });
  it("selects bounded, conflict-free tasks and serializes unknown scopes", () => {
    const graph = [task("a", ["src"]), task("b", ["src/app.ts"]), task("c", ["docs/readme.md"]), task("d", [])];
    expect(selectRunnableTaskBatch(graph, 3).map(item => item.id)).toEqual(["a", "c"]);
    expect(selectRunnableTaskBatch([task("unknown", []), task("known", ["x.ts"])], 3).map(item => item.id)).toEqual(["unknown"]);
    expect(() => selectRunnableTaskBatch(graph, 0)).toThrow(/maxWorkers/);
  });
  it("isolates failure impact to descendants and leaves independent tasks available", () => {
    const graph = [task("a", ["a.ts"]), task("b", ["b.ts"], ["a"]), task("c", ["c.ts"], ["b"]), task("independent", ["i.ts"])];
    expect(getFailureImpact(graph, ["a"])).toEqual({ affected: ["a", "b", "c"], unaffected: ["independent"] });
  });
});
