import { describe, expect, it } from "vitest";
import { createProjectMemorySnapshot, upsertProjectMemory, retrieveProjectMemory, removeProjectMemory } from "./projectMemory";
describe("project memory", () => {
  it("stores provenance-bound knowledge and retrieves only fresh matching records", () => {
    let memory = createProjectMemorySnapshot("project-a");
    memory = upsertProjectMemory(memory, { id: "decision-1", kind: "decision", title: "Use strict TypeScript", content: "New modules must enable strict type checking.", source: { type: "verified-task", reference: "task-12" }, expiresAt: null, confidence: 0.95, tags: ["typescript"] }, 100);
    expect(retrieveProjectMemory(memory, "strict TypeScript", 101)).toHaveLength(1);
    expect(retrieveProjectMemory(memory, "strict TypeScript", 101).at(0)?.source.reference).toBe("task-12");
    expect(removeProjectMemory(memory, "decision-1").records).toHaveLength(0);
  });
  it("rejects secret-bearing content and invalid provenance", () => {
    const memory = createProjectMemorySnapshot("project-a");
    expect(() => upsertProjectMemory(memory, { id: "secret-1", kind: "decision", title: "Token", content: "github_pat_" + "x".repeat(30), source: { type: "user", reference: "user" }, expiresAt: null, confidence: 1, tags: [] })).toThrow();
  });
});
