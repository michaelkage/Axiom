import { describe, expect, it } from "vitest";
import { prepareWorkerContext, prepareWorkerTask, resolveWorkerAgent } from "./workerPreparation";
import type { AxiomSubTask } from "../../shared/axiomRuntime";

const task: AxiomSubTask = {
  id: "task-1",
  title: "Implement API tests",
  scope: "Add focused tests for the API client.",
  targetFiles: ["src/api.test.ts"],
  dependsOn: [],
  acceptanceCriteria: ["Tests cover successful and failed requests."],
};

describe("worker preparation", () => {
  it("filters secrets from conversation and project memory before packing", () => {
    const result = prepareWorkerContext({
      request: "Add API tests",
      conversation: [
        { id: "safe-message", content: "Use the existing request helper.", relevance: 80 },
        { id: "credential-message", content: "api_key=super-secret-value", relevance: 99 },
      ],
      projectMemories: [
        { id: "safe-memory", content: "API tests use Vitest.", relevance: 90 },
        { id: "secret-memory", content: "Bearer abcdefghijklmnopqrstuvwxyz", relevance: 99 },
      ],
    });

    expect(result.conversation.map(item => item.id)).toEqual(["safe-message"]);
    expect(result.projectMemories.map(item => item.id)).toEqual(["safe-memory"]);
  });

  it("prefers a valid explicit task agent hint", () => {
    expect(resolveWorkerAgent(
      { ...task, agentHint: "testing" },
      ["implementation", "testing", "review"],
      "implementation",
    )).toEqual({ agent: "testing", roleHint: "testing" });
  });

  it("uses inferred specialist matching before the preferred agent", () => {
    expect(resolveWorkerAgent(task, ["implementation", "testing"], "implementation")).toEqual({
      agent: "testing",
      roleHint: "testing",
    });
  });

  it("uses preferred agent only when no specialist match exists", () => {
    expect(resolveWorkerAgent(
      { ...task, title: "Handle an unusual maintenance task", scope: "Update a small internal note." },
      ["review"],
      "review",
    )).toEqual({ agent: "review", roleHint: "implementation" });
  });

  it("leaves agent undefined when the runtime advertises no suitable agent", () => {
    expect(resolveWorkerAgent(
      { ...task, agentHint: "missing-agent" },
      [],
      "missing-agent",
    )).toEqual({ roleHint: "missing-agent" });
  });

  it("packs task context and builds a prompt with the actual isolated worktree path", () => {
    const prepared = prepareWorkerTask({
      task,
      request: "Improve API reliability",
      planSteps: ["Inspect the existing API client."],
      conversation: [{ id: "history-1", content: "The client uses fetch.", relevance: 70 }],
      projectMemories: [{ id: "memory-1", content: "Prefer Vitest for unit tests.", relevance: 90 }],
      completedTasks: [{ title: "Inspect client", summary: "Found retry helper." }],
    });

    const prompt = prepared.buildPrompt("/tmp/axiom-worker-task-1");
    expect(prompt).toContain("Isolated worktree path: /tmp/axiom-worker-task-1");
    expect(prompt).toContain("Tests cover successful and failed requests.");
    expect(prompt).toContain("Context budget: approximately");
    expect(prepared.packed.items.length).toBeGreaterThan(0);
  });
});
