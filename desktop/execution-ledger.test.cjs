"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createExecutionLedger } = require("./execution-ledger.cjs");

function objective(id = "objective-1") {
  return { id, title: "Test", instruction: "Verify ledger", status: "active", createdAt: 1, updatedAt: 1,
    revision: 1, budget: { maxAttempts: 3, maxElapsedMs: 60000, maxWorkers: 2, startedAt: 1, attemptsUsed: 0 },
    tasks: [{ id: "task-1", status: "queued" }], events: [{ id: id + ":1", type: "objective.started", sequence: 1, at: 1, payload: {} }] };
}
async function fixture(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-ledger-"));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("persists objectives atomically and scopes records to a workspace", async () => fixture(async root => {
  const ledger = createExecutionLedger(root, path.join(root, "project"));
  await ledger.create(objective());
  assert.equal((await ledger.get("objective-1")).revision, 1);
  assert.equal((await ledger.list()).length, 1);
  assert.equal(await createExecutionLedger(root, path.join(root, "other")).get("objective-1"), null);
}));

test("uses optimistic revision checks to reject stale writers", async () => fixture(async root => {
  const ledger = createExecutionLedger(root, path.join(root, "project"));
  await ledger.create(objective());
  const next = { ...objective(), revision: 2, updatedAt: 2 };
  const event = { id: "objective-1:2", type: "task.outcome", sequence: 2, at: 2, payload: {} };
  next.events.push(event);
  const results = await Promise.allSettled([
    ledger.commit("objective-1", 1, next, event),
    ledger.commit("objective-1", 1, next, event),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected").length, 1);
}));

test("refuses corrupt data and never overwrites it", async () => fixture(async root => {
  const workspace = path.join(root, "project");
  const ledger = createExecutionLedger(root, workspace);
  const crypto = require("node:crypto");
  const key = crypto.createHash("sha256").update(path.resolve(workspace)).digest("hex");
  const file = path.join(root, "execution-ledger", key + ".json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "{broken");
  await assert.rejects(ledger.list(), /corrupt JSON/);
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
}));

test("only terminal objectives can be removed", async () => fixture(async root => {
  const ledger = createExecutionLedger(root, path.join(root, "project"));
  await ledger.create(objective());
  await assert.rejects(ledger.remove("objective-1", 1), /Only terminal/);
  const terminal = { ...objective(), status: "completed", revision: 2, updatedAt: 2 };
  await ledger.commit("objective-1", 1, terminal);
  assert.equal(await ledger.remove("objective-1", 2), true);
  assert.equal(await ledger.get("objective-1"), null);
}));

test("shares write serialization across store instances and makes event retries idempotent", async () => fixture(async root => {
  const workspace = path.join(root, "project");
  const first = createExecutionLedger(root, workspace);
  const second = createExecutionLedger(root, workspace);
  await first.create(objective());
  const next = { ...objective(), revision: 2, updatedAt: 2 };
  const event = { id: "objective-1:2", type: "task.outcome", sequence: 2, at: 2, payload: {} };
  next.events.push(event);
  const initial = await first.commit("objective-1", 1, next, event);
  const retried = await second.commit("objective-1", 1, next, event);
  assert.equal(initial.objective.revision, 2);
  assert.equal(retried.duplicate, true);
  assert.equal((await first.get("objective-1")).events.length, 2);
}));
