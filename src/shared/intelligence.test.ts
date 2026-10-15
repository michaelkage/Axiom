import { describe, expect, it } from "vitest";
import {
  BUILTIN_PLUGIN_CATALOG, comboPromptForState, contextForSpecialist, coordinateTasks, DEFAULT_COMBOS, getAvailableCombos, getCombo, inferSpecialist, packContext,
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
    expect(packed.inputEstimatedTokens).toBeGreaterThan(packed.estimatedTokens);
    expect(packed.estimatedSavingsTokens).toBe(packed.inputEstimatedTokens - packed.estimatedTokens);
    expect(packed.estimatedSavingsPercent).toBeGreaterThan(0);
    expect(packed.omittedIds).toContain("noise");
  });

  it("exposes the three starter combos with safe ship-it confirmation", () => {
    expect(DEFAULT_COMBOS.map(combo => combo.id)).toEqual(["fix-it", "ship-it", "understand-it"]);
    expect(getCombo("ship-it").requiresConfirmation).toBe(true);
    expect(getAvailableCombos(["axiom-review-workflows"]).map(combo => combo.id)).toContain("review-it");
    expect(getAvailableCombos([]).map(combo => combo.id)).not.toContain("review-it");
    expect(() => getCombo("unknown")).toThrow(/Unknown Axiom combo/);
  });

  it("suggests next actions based on concrete workspace state", () => {
    const suggestions = suggestNextActions({ lastFailure: "timeout", changedFiles: ["src/a.ts"], checksPassed: false });
    expect(suggestions[0]?.id).toBe("diagnose-failure");
    expect(suggestions.map(item => item.id)).toContain("verify-changes");
    expect(suggestNextActions({})[0]?.id).toBe("clarify-goal");
  });

  it("packs request, scope, target files, and completed dependency context for a specialist", () => {
    const packed = contextForSpecialist({
      request: "Preserve the public API",
      taskTitle: "Implement handler",
      taskScope: "Add the handler",
      targetFiles: ["src/handler.ts"],
      completedTasks: [{ title: "Research", status: "succeeded", summary: "Use the existing adapter." }],
    });
    const combined = packed.items.map(item => item.content).join("\n");
    expect(combined).toContain("Preserve the public API");
    expect(combined).toContain("src/handler.ts");
    expect(combined).toContain("Use the existing adapter.");
  });

  it("adapts combo prompts and next actions to real task outcomes", () => {
    const prompt = comboPromptForState(getCombo("fix-it"), [
      { taskId: "api", title: "API task", status: "failed", error: "Type-check failed" },
    ]);
    expect(prompt).toContain("API task: failed");
    expect(prompt).toContain("Type-check failed");
    expect(suggestNextActions({ taskOutcomes: [{ title: "API task", status: "failed", error: "Type-check failed" }] })[0]?.id).toBe("retry-failed-tasks");
  });

  it("lists only permission-reviewed built-in workflow packs as safe catalog entries", () => {
    expect(BUILTIN_PLUGIN_CATALOG.length).toBeGreaterThan(0);
    expect(BUILTIN_PLUGIN_CATALOG.find(item => item.id === "community-command-runner")?.verified).toBe(false);
    expect(reviewPluginManifest(BUILTIN_PLUGIN_CATALOG.find(item => item.id === "community-command-runner")!).requiredApprovals).toContain("run-commands");
  });

  it("fails closed on malformed manifests and unknown plugin capabilities", () => {
    const malformed = reviewPluginManifest({ id: "bad", version: "", publisher: "", description: "", permissions: undefined as unknown as ["read-files"], verified: true });
    expect(malformed.installable).toBe(false);
    expect(malformed.warnings).toContain("Plugin permissions must be declared as an array.");

    const unknown = reviewPluginManifest({
      id: "community-tools", version: "1.0.0", publisher: "community", description: "Tools",
      permissions: ["read-files", "root-access" as "read-files"], verified: true,
    });
    expect(unknown.installable).toBe(false);
    expect(unknown.warnings.some(warning => warning.includes("unknown capability"))).toBe(true);
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
