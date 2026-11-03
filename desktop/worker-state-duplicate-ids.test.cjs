"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createWorkerStateStore } = require("./worker-state.cjs");

test("duplicate task IDs in persisted history are rejected without overwriting the file", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-duplicate-ids-"));
  try {
    const workspace = path.join(temp, "workspace"), user = path.join(temp, "user");
    await fs.mkdir(workspace);
    const key = crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex");
    const file = path.join(user, "worker-state", key + ".json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const state = {
      schemaVersion: 1, workspaceRoot: path.resolve(workspace),
      tasks: [
        { taskId: "duplicate", title: "First", status: "queued" },
        { taskId: "duplicate", title: "Second", status: "running" }
      ]
    };
    const original = JSON.stringify(state);
    await fs.writeFile(file, original, "utf8");
    const store = createWorkerStateStore(user, workspace);
    await assert.rejects(store.list(), /invalid schema or task record; refusing to overwrite/);
    await assert.rejects(store.record({ taskId: "new", title: "New task", status: "queued" }), /invalid schema or task record; refusing to overwrite/);
    assert.equal(await fs.readFile(file, "utf8"), original);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
