"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore } = require("./worker-state.cjs");

test("a newer running attempt reopens each terminal outcome and rejects stale events", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-terminal-retry-"));
  try {
    const workspace = path.join(temp, "workspace");
    const userData = path.join(temp, "user");
    await fs.mkdir(workspace);
    const store = createWorkerStateStore(userData, workspace);
    for (const status of ["blocked", "cancelled", "timed_out"]) {
      const taskId = "retry-" + status;
      await store.record({
        taskId, title: taskId, status, attempt: 1,
        error: "attempt one " + status, finishedAt: 100, logs: ["attempt one"]
      });
      const retry = await store.record({
        taskId, title: taskId, status: "running", attempt: 2,
        sessionId: "session-two", logs: ["attempt two"]
      });
      assert.equal(retry.status, "running");
      assert.equal(retry.attempt, 2);
      assert.equal(retry.error, undefined);
      assert.equal(retry.finishedAt, undefined);
      assert.deepEqual(retry.logs, ["attempt two"]);
      const stale = await store.record({
        taskId, title: taskId, status, attempt: 1,
        error: "stale terminal", finishedAt: 150
      });
      assert.equal(stale.status, "running");
      assert.equal(stale.attempt, 2);
      assert.equal(stale.sessionId, "session-two");
      assert.equal(stale.error, undefined);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
