import { describe, expect, it } from "vitest";
import { isProjectMemoryStale } from "./projectMemory";
import type { ProjectMemory } from "../../shared/axiomWorkflow";

const memory: ProjectMemory = {
  id: "memory-1",
  category: "decision",
  content: "Keep domain services independent of UI components.",
  tags: ["architecture"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("project memory freshness", () => {
  it("flags memories that have not been reviewed for 180 days", () => {
    const now = Date.parse("2026-10-15T00:00:00.000Z");
    expect(isProjectMemoryStale(memory, now)).toBe(true);
  });

  it("keeps recently reviewed memories fresh", () => {
    const now = Date.parse("2026-10-15T00:00:00.000Z");
    expect(isProjectMemoryStale({ ...memory, updatedAt: "2026-10-01T00:00:00.000Z" }, now)).toBe(false);
  });

  it("flags invalid timestamps for manual review", () => {
    expect(isProjectMemoryStale({ ...memory, updatedAt: "not-a-date" })).toBe(true);
  });
});
