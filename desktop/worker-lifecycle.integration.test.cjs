"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore } = require("./worker-state.cjs");

async function withWorkspace(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-lifecycle-"));
  const workspace = path.join(temp, "workspace");
  const userData = path.join(temp, "user-data");
  await fs.mkdir(workspace, { recursive: true });
  try {
    await run({ workspace, userData });
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

test("worker lifecycle persists failure, retry, success, and ignores stale attempt events", async () => {
  await withWorkspace(async ({ workspace, userData }) => {
    const store = createWorkerStateStore(userData, workspace);

    const queued = await store.record({
      taskId: "integration-task",
      title: "Build and verify feature",
      status: "queued",
      attempt: 1,
      logs: ["planner queued task"],
    });
    assert.equal(queued.status, "queued");

    const running1 = await store.record({
      taskId: "integration-task",
      title: "Build and verify feature",
      status: "running",
      attempt: 1,
      sessionId: "session-attempt-1",
      worktreePath: "/tmp/axiom-attempt-1",
      startedAt: 100,
      logs: ["worker started", "verification failed"],
    });
    assert.equal(running1.status, "running");

    const failed = await store.record({
      taskId: "integration-task",
      title: "Build and verify feature",
      status: "failed",
      attempt: 1,
      error: "Could not create child session: runtime unavailable",
      worktreePath: "/tmp/axiom-attempt-1",
      logs: ["isolated worktree created", "child session startup failed"],
      finishedAt: 200,
    });
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /child session startup failed|runtime unavailable/);
    assert.equal(failed.worktreePath, "/tmp/axiom-attempt-1");
    assert.deepEqual(failed.logs, ["isolated worktree created", "child session startup failed"]);

    const retry = await store.record({
      taskId: "integration-task",
      title: "Build and verify feature",
      status: "running",
      attempt: 2,
      sessionId: "session-attempt-2",
      worktreePath: "/tmp/axiom-attempt-2",
      startedAt: 300,
      logs: ["retry started"],
    });
    assert.equal(retry.status, "running");
    assert.equal(retry.attempt, 2);
    assert.equal(retry.sessionId, "session-attempt-2");
    assert.equal(retry.error, undefined);

    const delayedFailure = await store.record({
      taskId: "integration-task",
      title: "Build and verify feature",
      status: "failed",
      attempt: 1,
      error: "late failure from previous worker",
      finishedAt: 350,
    });
    assert.equal(delayedFailure.status, "running");
    assert.equal(delayedFailure.attempt, 2);

    const succeeded = await store.record({
      taskId: "integration-task",
      title: "Build and verify feature",
      status: "succeeded",
      attempt: 2,
      result: "Build and verification passed",
      finishedAt: 400,
      logs: ["retry started", "build passed", "verification passed"],
    });
    assert.equal(succeeded.status, "succeeded");
    assert.equal(succeeded.result, "Build and verification passed");

    const restartedStore = createWorkerStateStore(userData, workspace);
    const persisted = (await restartedStore.list()).find((task) => task.taskId === "integration-task");
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.attempt, 2);
    assert.equal(persisted.sessionId, "session-attempt-2");
    assert.equal(persisted.worktreePath, "/tmp/axiom-attempt-2");
    assert.deepEqual(persisted.logs, ["retry started", "build passed", "verification passed"]);
    assert.equal(persisted.result, "Build and verification passed");

    // Startup recovery must leave completed work terminal; it must never enqueue or rerun it.
    const afterRestartRecovery = await restartedStore.recoverInterrupted();
    const completedAfterRecovery = afterRestartRecovery.find((task) => task.taskId === "integration-task");
    assert.equal(completedAfterRecovery.status, "succeeded");
    assert.equal(completedAfterRecovery.attempt, 2);
    assert.equal(completedAfterRecovery.result, "Build and verification passed");
  });
});

test("restart recovery records interrupted execution and preserves diagnostic context", async () => {
  await withWorkspace(async ({ workspace, userData }) => {
    const store = createWorkerStateStore(userData, workspace);
    await store.record({
      taskId: "interrupted-task",
      title: "Run checks",
      status: "running",
      attempt: 3,
      sessionId: "session-3",
      worktreePath: "/tmp/axiom-worktree-3",
      logs: ["worker spawned", "test command started"],
    });

    const recovered = await createWorkerStateStore(userData, workspace).recoverInterrupted();
    const task = recovered.find((item) => item.taskId === "interrupted-task");
    assert.equal(task.status, "failed");
    assert.equal(task.attempt, 3);
    assert.equal(task.sessionId, "session-3");
    assert.equal(task.worktreePath, "/tmp/axiom-worktree-3");
    assert.match(task.error, /Axiom restarted/);
    assert.deepEqual(task.logs, ["worker spawned", "test command started"]);

    const staleCompletion = await createWorkerStateStore(userData, workspace).record({
      taskId: "interrupted-task",
      title: "Run checks",
      status: "succeeded",
      attempt: 3,
      result: "late completion",
      finishedAt: 999,
    });
    assert.equal(staleCompletion.status, "failed");
    assert.equal(staleCompletion.result, undefined);
  });
});

test("late quarantined-worker diagnostics enrich the terminal timeout without reopening it", async () => {
  await withWorkspace(async ({ workspace, userData }) => {
    const store = createWorkerStateStore(userData, workspace);
    await store.record({
      taskId: "late-worker",
      title: "Inspect quarantined worker",
      status: "running",
      attempt: 1,
      startedAt: 100,
      error: "Worker is still starting",
    });
    const quarantined = await store.record({
      taskId: "late-worker",
      title: "Inspect quarantined worker",
      status: "timed_out",
      attempt: 1,
      finishedAt: 200,
      error: "Worker abort was not confirmed; task quarantined.",
    });
    assert.equal(quarantined.status, "timed_out");

    const enriched = await store.record({
      taskId: "late-worker",
      title: "Inspect quarantined worker",
      status: "timed_out",
      attempt: 1,
      sessionId: "late-session",
      worktreePath: "/tmp/axiom-late-worker",
      logs: ["late worker startup completed"],
      finishedAt: 250,
    });
    assert.equal(enriched.status, "timed_out");
    assert.equal(enriched.sessionId, "late-session");
    assert.equal(enriched.worktreePath, "/tmp/axiom-late-worker");
    assert.deepEqual(enriched.logs, ["late worker startup completed"]);

    const staleSuccess = await store.record({
      taskId: "late-worker",
      title: "Inspect quarantined worker",
      status: "succeeded",
      attempt: 1,
      result: "late success must not release quarantine",
      finishedAt: 300,
    });
    assert.equal(staleSuccess.status, "timed_out");
    assert.equal(staleSuccess.result, undefined);

    const persisted = (await createWorkerStateStore(userData, workspace).list())
      .find(task => task.taskId === "late-worker");
    assert.equal(persisted.status, "timed_out");
    assert.equal(persisted.sessionId, "late-session");
    assert.equal(persisted.worktreePath, "/tmp/axiom-late-worker");
  });
});
