"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore } = require("./worker-state.cjs");

test("blocked, cancelled, and timed-out outcomes reject late same-attempt events", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-terminal-outcomes-"));
  try {
    const workspace = path.join(temp, "workspace");
    const userData = path.join(temp, "user");
    await fs.mkdir(workspace);
    const store = createWorkerStateStore(userData, workspace);
    for (const status of ["blocked", "cancelled", "timed_out"]) {
      const taskId = "terminal-" + status;
      const originalError = "original " + status + " reason";
      await store.record({
        taskId, title: taskId, status: "running", attempt: 1,
        sessionId: "session-" + status, logs: ["started"]
      });
      const terminal = await store.record({
        taskId, title: taskId, status, attempt: 1,
        error: originalError, finishedAt: 100, logs: ["started", status]
      });
      assert.equal(terminal.status, status);
      const late = await store.record({
        taskId, title: taskId, status: "running", attempt: 1,
        error: "late event", logs: ["stale log"]
      });
      assert.equal(late.status, status);
      assert.equal(late.error, originalError);
      assert.equal(late.finishedAt, 100);
      assert.deepEqual(late.logs, ["started", status]);
    }
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
