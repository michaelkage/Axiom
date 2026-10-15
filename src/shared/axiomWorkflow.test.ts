import { describe, expect, it } from "vitest";
import {
  evaluateQualityGate, validateTaskPlan, replanAfterOutcomes, selectIntegrationChanges,
  rememberProjectFact, forgetProjectMemory, retrieveProjectMemories, summarizeBuildOutcome,
  type ProjectMemory, type ProjectMemoryStore,
} from "./axiomWorkflow";

const ready = { status: "Ready to review" as const, checks: [{ name: "tests", state: "passed" as const, exitCode: 0 }], unexpectedPaths: [], unfinishedRequirements: [], reasons: [] };
describe("Axiom product workflow primitives", () => {
  it("requires actual passing evidence and reports scope violations", () => {
    expect(evaluateQualityGate({ checks: [{ name: "build", state: "passed", exitCode: 0 }], changes: [{ path: "src/a.ts" }], expectedPaths: ["src/a.ts"] }).status).toBe("Ready to review");
    const result = evaluateQualityGate({ checks: [{ name: "tests", state: "unverified" }], changes: [{ path: "secrets.txt" }], expectedPaths: ["src/a.ts"], unfinishedRequirements: ["Add validation"] });
    expect(result.status).toBe("Needs fixes");
    expect(result.unexpectedPaths).toEqual(["secrets.txt"]);
  });
  it("does not mark a task review-ready when no verification checks ran", () => {
    expect(evaluateQualityGate({ checks: [], changes: [] }).status).toBe("Needs fixes");
  });
  it("does not treat a passed label without exit-code evidence as verified", () => {
    const result = evaluateQualityGate({ checks: [{ name: "tests", state: "passed" }], changes: [] });
    expect(result.status).toBe("Needs fixes");
    expect(result.reasons).toContain("One or more checks lack passing evidence.");
  });
  it("blocks when execution is blocked and flags failed checks", () => {
    expect(evaluateQualityGate({ checks: [], changes: [], blockedReason: "Gateway unavailable" }).status).toBe("Blocked");
    expect(evaluateQualityGate({ checks: [{ name: "lint", state: "failed", exitCode: 1 }], changes: [] }).status).toBe("Needs fixes");
  });
  it("validates acceptance criteria and task dependency cycles", () => {
    const task = { id: "a", title: "Build", scope: "Add feature", targetFiles: ["src/a.ts"], dependsOn: [], acceptanceCriteria: [{ id: "a1", description: "Feature renders" }] };
    expect(validateTaskPlan([task])).toHaveLength(1);
    expect(() => validateTaskPlan([{ ...task, acceptanceCriteria: [] }])).toThrow(/acceptance criteria/);
    expect(() => validateTaskPlan([{ ...task, dependsOn: ["b"] }, { ...task, id: "b", dependsOn: ["a"] }])).toThrow(/cycle/);
  });
  it("replans by blocking only descendants of failed tasks", () => {
    const tasks = [{ id: "a", dependsOn: [] }, { id: "b", dependsOn: ["a"] }, { id: "c", dependsOn: [] }];
    expect(replanAfterOutcomes(tasks, [{ taskId: "a", status: "failed" }])).toEqual({ completed: [], failed: ["a"], blocked: ["b"], remaining: [tasks[2]] });
  });
  it("only permits selective integration for review-ready results without path conflicts", () => {
    const result = { taskId: "a", summary: "Added feature", changes: [{ path: "src/a.ts" }], quality: ready };
    expect(selectIntegrationChanges(["a"], [result]).safeToApply).toBe(true);
    expect(selectIntegrationChanges(["a"], [{ ...result, quality: { ...ready, status: "Needs fixes" } }]).safeToApply).toBe(false);
    expect(selectIntegrationChanges(["a", "b"], [result, { ...result, taskId: "b" }]).conflicts).toEqual(["src/a.ts"]);
  });
  it("stores, retrieves and deletes project memory through an explicit adapter", async () => {
    let data: ProjectMemory[] = [];
    const store: ProjectMemoryStore = { load: async () => data.map(x => ({ ...x })), save: async next => { data = next; } };
    const memory = { id: "arch-1", category: "architecture" as const, content: "Use SolidJS components", tags: ["ui", "solid"], createdAt: "2026-01-01", updatedAt: "2026-01-01" };
    await rememberProjectFact(store, memory);
    expect(retrieveProjectMemories(data, "solid UI")).toHaveLength(1);
    expect(await forgetProjectMemory(store, memory.id)).toBe(true);
    expect(await forgetProjectMemory(store, memory.id)).toBe(false);
  });
  it("summarizes requirements, checks and next steps without claiming missing evidence", () => {
    const summary = summarizeBuildOutcome({ title: "Settings panel", completedRequirements: ["Panel added"], outstandingRequirements: ["Persist preferences"], changedFiles: ["src/a.ts", "src/a.ts"], checks: [{ name: "tests", state: "passed" }, { name: "build", state: "unverified" }] });
    expect(summary.status).toBe("Needs attention");
    expect(summary.changedFiles).toEqual(["src/a.ts"]);
    expect(summary.outstandingChecks).toEqual(["build"]);
    expect(summary.suggestedNextSteps.length).toBeGreaterThan(0);
  });
});
