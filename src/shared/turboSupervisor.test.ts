import { describe, expect, it } from "vitest";
import { decideTurboNext, getRequeueableBlockedTaskIds, type TurboTask } from "./turboSupervisor";
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
  it("blocks duplicate or empty task IDs before they can corrupt dependency lookup", () => {
    expect(decideTurboNext([task("duplicate"), task("duplicate")], policy)).toMatchObject({
      action: "blocked",
      taskIds: ["duplicate"],
    });
    expect(decideTurboNext([task(" ")], policy)).toMatchObject({ action: "blocked" });
  });
  it("identifies the tasks involved in a dependency cycle", () => {
    const result = decideTurboNext([
      task("a", { dependsOn: ["b"] }),
      task("b", { dependsOn: ["a"] }),
      task("independent"),
    ], policy);
    expect(result.action).toBe("blocked");
    if (result.action !== "blocked") throw new Error("Expected a blocked decision");
    expect(result.taskIds.sort()).toEqual(["a", "b"]);
    expect(result.reason).toContain("cycle");
  });
  it("requeues blocked replacement tasks using the current task graph", () => {
    const tasks = [
      task("original-prerequisite", { status: "succeeded" }),
      task("replan-1-0-replacement", { dependsOn: ["original-prerequisite"], status: "blocked" }),
      task("still-blocked", { dependsOn: ["not-yet-succeeded"], status: "blocked" }),
    ];
    expect(getRequeueableBlockedTaskIds(tasks, ["replan-1-0-replacement", "still-blocked", "unknown-task"], ["original-prerequisite"]))
      .toEqual(["replan-1-0-replacement"]);
  });

  it("stops cleanly when replanning has exhausted the remaining attempt budget", () => {
    expect(decideTurboNext([task("a")], { ...policy, maxTotalAttempts: 0 })).toMatchObject({
      action: "stop",
      reason: "Turbo total-attempt budget exhausted.",
    });
  });

  it("rejects invalid policy budgets instead of silently stalling", () => {
    expect(decideTurboNext([task("a")], { ...policy, maxParallelWorkers: 0 })).toMatchObject({ action: "blocked", taskIds: [] });
    expect(decideTurboNext([task("a")], { ...policy, maxTotalAttempts: Number.NaN })).toMatchObject({ action: "blocked", taskIds: [] });
    expect(decideTurboNext([task("a")], { ...policy, maxRuntimeMs: Number.POSITIVE_INFINITY })).toMatchObject({ action: "blocked", taskIds: [] });
  });

  it("does not retry failed work until its dependencies have succeeded", () => {
    const prerequisite = task("prerequisite", { status: "running", attempts: 1 });
    const dependent = task("dependent", { status: "failed", attempts: 1, dependsOn: ["prerequisite"] });
    expect(decideTurboNext([prerequisite, dependent], policy)).toMatchObject({ action: "wait" });
    expect(decideTurboNext([
      task("prerequisite", { status: "succeeded", attempts: 1 }),
      dependent,
    ], policy)).toMatchObject({ action: "retry", taskIds: ["dependent"] });
  });

  it("blocks invalid attempt counters instead of dispatching malformed work", () => {
    expect(decideTurboNext([task("negative", { attempts: -1 })], policy)).toMatchObject({ action: "blocked", taskIds: ["negative"] });
    expect(decideTurboNext([task("over-limit", { attempts: 3, maxAttempts: 2 })], policy)).toMatchObject({ action: "blocked", taskIds: ["over-limit"] });
    expect(decideTurboNext([task("fractional", { attempts: 0.5 })], policy)).toMatchObject({ action: "blocked", taskIds: ["fractional"] });
  });
});
