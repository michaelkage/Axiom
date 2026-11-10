"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createWorkerStateStore } = require("./worker-state.cjs");

test("preserves worker state whose embedded workspace root does not match", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-worker-root-mismatch-"));
  try {
    const userData = path.join(temp, "user");
    const workspace = path.join(temp, "workspace");
    await fs.mkdir(workspace);
    const key = crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex");
    const file = path.join(userData, "worker-state", key + ".json");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const persisted = JSON.stringify({
      schemaVersion: 1,
      workspaceRoot: path.join(temp, "other-workspace"),
      updatedAt: new Date(0).toISOString(),
      tasks: []
    });
    await fs.writeFile(file, persisted, "utf8");

    const store = createWorkerStateStore(userData, workspace);
    await assert.rejects(store.list(), /invalid schema or task record/);
    await assert.rejects(
      store.record({ taskId: "new", title: "New task", status: "queued" }),
      /invalid schema or task record/
    );
    assert.equal(await fs.readFile(file, "utf8"), persisted);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
