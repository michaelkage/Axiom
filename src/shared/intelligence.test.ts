import { describe, expect, it } from "vitest";
import {
  coordinateTasks, DEFAULT_COMBOS, getCombo, inferSpecialist, packContext,
  reviewPluginManifest, suggestNextActions,
} from "./intelligence";

describe("Axiom intelligence layer", () => {
  it("assigns specialist roles from task intent and rejects duplicate task IDs", () => {
    expect(inferSpecialist("Debug the failing login flow")).toBe("debugging");
    expect(inferSpecialist("Explain the app architecture")).toBe("research");
    expect(coordinateTasks([{ id: "tests", title: "Tests", prompt: "add tests", kind: "test" }])[0]?.role).toBe("testing");
    expect(() => coordinateTasks([
      { id: "same", title: "one", prompt: "one" },
      { id: "same", title: "two", prompt: "two" },
    ])).toThrow(/unique/);
    expect(coordinateTasks([
      { id: "first", title: "First", prompt: "implement" },
      { id: "second", title: "Second", prompt: "test", dependsOn: ["first"] },
    ])[1]?.dependsOn).toEqual(["first"]);
    expect(() => coordinateTasks([
      { id: "first", title: "First", prompt: "implement", dependsOn: ["second"] },
      { id: "second", title: "Second", prompt: "test", dependsOn: ["first"] },
    ])).toThrow(/dependency cycle/);
  });

  it("normalizes target paths and blocks traversal", () => {
    expect(coordinateTasks([{ id: "a", title: "A", prompt: "implement", targetFiles: ["./src\\app.tsx", "src/app.tsx"] }])[0]?.targetFiles).toEqual(["src/app.tsx"]);
    expect(() => coordinateTasks([{ id: "bad", title: "Bad", prompt: "change", targetFiles: ["../secrets"] }])).toThrow(/Unsafe/);
  });

  it("packs highest-value context first, deduplicates IDs, and respects the budget", () => {
    const packed = packContext([
      { id: "old", content: "old decision", kind: "decision", relevance: 1, updatedAt: 1 },
      { id: "old", content: "new decision", kind: "decision", relevance: 2, updatedAt: 2 },
      { id: "noise", content: "x".repeat(200), kind: "tool-output", relevance: 99 },
      { id: "constraint", content: "must preserve API", kind: "constraint", relevance: 1 },
    ], 12);
    expect(packed.items.map(item => item.id)).toContain("constraint");
    expect(packed.items.find(item => item.id === "old")?.content).toBe("new decision");
    expect(packed.estimatedTokens).toBeLessThanOrEqual(12);
    expect(packed.omittedIds).toContain("noise");
  });

  it("exposes the three starter combos with safe ship-it confirmation", () => {
    expect(DEFAULT_COMBOS.map(combo => combo.id)).toEqual(["fix-it", "ship-it", "understand-it"]);
    expect(getCombo("ship-it").requiresConfirmation).toBe(true);
    expect(() => getCombo("unknown")).toThrow(/Unknown Axiom combo/);
  });

  it("suggests next actions based on concrete workspace state", () => {
    const suggestions = suggestNextActions({ lastFailure: "timeout", changedFiles: ["src/a.ts"], checksPassed: false });
    expect(suggestions[0]?.id).toBe("diagnose-failure");
    expect(suggestions.map(item => item.id)).toContain("verify-changes");
    expect(suggestNextActions({})[0]?.id).toBe("clarify-goal");
  });

  it("requires verification and explicit approval for sensitive plugin permissions", () => {
    const review = reviewPluginManifest({
      id: "community-tools", version: "1.0.0", publisher: "community", description: "Tools",
      permissions: ["read-files", "run-commands", "network"], verified: false, sourceUrl: "http://example.com",
    });
    expect(review.installable).toBe(false);
    expect(review.requiredApprovals).toEqual(["run-commands", "network"]);
    expect(review.warnings).toContain("Plugin source must use HTTPS.");
  });
});
