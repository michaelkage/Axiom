import { describe, expect, it } from "vitest";
import { applySupervisorTaskOutcome, createAutonomousObjective, getSupervisorSnapshot, setObjectiveStatus } from "./autonomousSupervisor";

const tasks = [
  { id: "plan", title: "Plan", scope: "Plan work", targetFiles: ["docs/plan.md"], dependsOn: [], acceptanceCriteria: ["Plan is clear"] },
  { id: "build", title: "Build", scope: "Build feature", targetFiles: ["src/feature.ts"], dependsOn: ["plan"], acceptanceCriteria: ["Feature works"] },
];
const outcome = (taskId: string, status: "running" | "succeeded" | "failed", attempt: number) => ({ taskId, title: taskId, status, attempt });

describe("autonomous supervisor domain", () => {
  it("creates bounded objectives with an initial event and stable task states", () => {
    const objective = createAutonomousObjective({ id: "obj-1", title: "Ship feature", instruction: "Build and verify it", tasks }, { now: () => 100 });
    expect(objective.status).toBe("active");
    expect(objective.tasks.map(task => task.status)).toEqual(["queued", "queued"]);
    expect(objective.events[0]).toMatchObject({ id: "obj-1:1", type: "objective.started" });
  });
  it("rejects invalid IDs, duplicate tasks and invalid budgets", () => {
    expect(() => createAutonomousObjective({ id: "../x", title: "x", instruction: "x", tasks })).toThrow(/unsupported/);
    expect(() => createAutonomousObjective({ id: "x", title: "x", instruction: "x", tasks: [tasks[0], tasks[0]] })).toThrow(/Duplicate/);
    expect(() => createAutonomousObjective({ id: "x", title: "x", instruction: "x", tasks }, { maxWorkers: 0 })).toThrow(/maxWorkers/);
  });
  it("counts worker attempts only when a new running generation begins", () => {
    let objective = createAutonomousObjective({ id: "obj", title: "Feature", instruction: "Do it", tasks }, { now: () => 100 });
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "running", 1), { now: () => 110 });
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "succeeded", 1), { now: () => 120 });
    expect(objective.budget.attemptsUsed).toBe(1);
    expect(objective.tasks[0].status).toBe("succeeded");
  });
  it("ignores stale outcomes and rejects skipped attempt generations", () => {
    let objective = createAutonomousObjective({ id: "obj", title: "Feature", instruction: "Do it", tasks });
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "running", 1));
    const stale = applySupervisorTaskOutcome(objective, outcome("plan", "failed", 0));
    expect(stale.tasks[0].status).toBe("running");
    expect(() => applySupervisorTaskOutcome(objective, outcome("plan", "running", 3))).toThrow(/skipped/);
  });
  it("completes only after every task has succeeded", () => {
    let objective = createAutonomousObjective({ id: "obj", title: "Feature", instruction: "Do it", tasks });
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "running", 1));
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "succeeded", 1));
    objective = applySupervisorTaskOutcome(objective, outcome("build", "running", 1));
    objective = applySupervisorTaskOutcome(objective, outcome("build", "succeeded", 1));
    expect(objective.status).toBe("completed");
    expect(getSupervisorSnapshot(objective).completionPercent).toBe(100);
  });
  it("blocks on failure and supports explicit resume after replanning", () => {
    let objective = createAutonomousObjective({ id: "obj", title: "Feature", instruction: "Do it", tasks });
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "running", 1));
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "failed", 1));
    expect(objective.status).toBe("blocked");
    objective = setObjectiveStatus(objective, "resume");
    expect(objective.status).toBe("active");
  });
  it("enforces wall-clock and attempt budgets before launching another attempt", () => {
    let objective = createAutonomousObjective({ id: "obj", title: "Feature", instruction: "Do it", tasks }, { maxAttempts: 1, maxElapsedMs: 100, now: () => 0 });
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "running", 1), { now: () => 10 });
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "failed", 1), { now: () => 20 });
    objective = setObjectiveStatus(objective, "resume", 30);
    objective = applySupervisorTaskOutcome(objective, outcome("plan", "running", 2), { now: () => 40 });
    expect(objective.status).toBe("blocked");
    expect(objective.budget.attemptsUsed).toBe(1);
    expect(objective.events.some(event => event.type === "budget.exhausted")).toBe(true);
  });
  it("pauses and cancels without allowing terminal objectives to resume", () => {
    let objective = createAutonomousObjective({ id: "obj", title: "Feature", instruction: "Do it", tasks });
    objective = setObjectiveStatus(objective, "pause");
    expect(objective.status).toBe("paused");
    objective = setObjectiveStatus(objective, "cancel");
    expect(objective.status).toBe("cancelled");
    expect(objective.tasks.every(task => task.status === "cancelled")).toBe(true);
    expect(() => setObjectiveStatus(objective, "resume")).toThrow(/terminal/);
  });
});
