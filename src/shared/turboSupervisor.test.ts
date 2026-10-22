import { describe, expect, it } from "vitest";
import { decideTurboNext, type TurboTask } from "./turboSupervisor";
const policy = { maxParallelWorkers: 2, maxTotalAttempts: 10, maxRuntimeMs: 60_000, startedAt: 100, now: 200 };
const task = (id: string, extra: Partial<TurboTask> = {}): TurboTask => ({ id, title: id, dependsOn: [], acceptanceCriteria: ["verified"], attempts: 0, maxAttempts: 2, status: "queued", ...extra });
describe("Turbo supervisor policy", () => {
  it("dispatches independent work up to the concurrency limit", () => expect(decideTurboNext([task("a"), task("b"), task("c")], policy)).toMatchObject({ action: "dispatch", taskIds: ["a", "b"] }));
  it("waits for dependencies and dispatches once ready", () => {
    expect(decideTurboNext([task("a", { status: "running" }), task("b", { dependsOn: ["a"] })], policy).action).toBe("wait");
    expect(decideTurboNext([task("a", { status: "succeeded" }), task("b", { dependsOn: ["a"] })], policy)).toMatchObject({ action: "dispatch", taskIds: ["b"] });
  });
  it("retries within bounds and requests replan after exhaustion", () => {
    expect(decideTurboNext([task("a", { status: "failed", attempts: 1 })], policy)).toMatchObject({ action: "retry", taskIds: ["a"] });
    expect(decideTurboNext([task("a", { status: "failed", attempts: 2 })], policy).action).toBe("replan");
  });
  it("waits for active siblings before replanning exhausted work", () => {
    expect(decideTurboNext([
      task("failed", { status: "failed", attempts: 2 }),
      task("active", { status: "running", attempts: 1 }),
    ], policy)).toMatchObject({ action: "wait" });
  });
  it("does not replan exhausted work while all worker slots are occupied", () => {
    expect(decideTurboNext([
      task("exhausted", { status: "failed", attempts: 2 }),
      task("retryable", { status: "failed", attempts: 1 }),
      task("active-a", { status: "running", attempts: 1 }),
      task("active-b", { status: "running", attempts: 1 }),
    ], policy)).toMatchObject({ action: "wait" });
  });
  it("honors stop and runtime/attempt budgets", () => {
    expect(decideTurboNext([task("a")], { ...policy, stopRequested: true }).action).toBe("stop");
    expect(decideTurboNext([task("a")], { ...policy, now: 70_100 }).action).toBe("stop");
    expect(decideTurboNext([task("a", { status: "running", attempts: 1 })], { ...policy, maxTotalAttempts: 1 }).action).toBe("stop");
  });
  it("only reports completion when every task succeeded", () => {
    expect(decideTurboNext([task("a", { status: "succeeded" })], policy).action).toBe("complete");
    expect(decideTurboNext([task("a", { status: "cancelled" })], policy).action).toBe("blocked");
  });
  it("flags missing dependencies rather than silently stalling", () => expect(decideTurboNext([task("a", { dependsOn: ["missing"] })], policy).action).toBe("blocked"));
  it("releases a previously blocked dependent after its prerequisite succeeds on retry", () => {
    const prerequisite = task("prerequisite", { status: "succeeded", attempts: 2 });
    const dependent = task("dependent", { status: "blocked", dependsOn: ["prerequisite"] });
    expect(decideTurboNext([prerequisite, dependent], policy)).toMatchObject({
      action: "dispatch",
      taskIds: ["dependent"],
    });
  });
});
