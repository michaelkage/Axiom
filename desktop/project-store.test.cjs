"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createProjectStore, isValidChange, MAX_EVENTS } = require("./project-store.cjs");

test("project state persists context and bounded change history", async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-project-store-"));
  try {
    const workspace = path.join(temporary, "repo");
    await fs.mkdir(workspace);
    const store = createProjectStore(path.join(temporary, "user-data"), workspace);
    await store.saveContext("Prefer small, tested changes.");
    for (let index = 0; index < MAX_EVENTS + 5; index += 1) {
      await store.addChange({ title: "Change " + index, summary: "Summary " + index, status: "verified" });
    }
    const state = await store.read();
    assert.equal(state.context, "Prefer small, tested changes.");
    assert.equal(state.changes.length, MAX_EVENTS);
    assert.equal(state.changes.at(-1).title, "Change " + (MAX_EVENTS + 4));
    assert.equal(state.workspaceRoot, workspace);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
});

test("change events reject invalid statuses and empty titles", () => {
  assert.equal(isValidChange({ title: "X", summary: "Y", status: "verified" }), true);
  assert.equal(isValidChange({ title: "X", summary: "Y", status: "successful-ish" }), false);
  assert.equal(isValidChange({ title: " ", summary: "Y", status: "verified" }), false);
});
