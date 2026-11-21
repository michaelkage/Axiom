"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { validatePluginManifest } = require("./plugin-runtime.cjs");

test("accepts a bounded manifest and canonicalizes capabilities", () => {
  const manifest = validatePluginManifest({ apiVersion: 1, id: "sample.plugin", name: "Sample", entry: "index.cjs", capabilities: ["project.read"], resources: { timeoutMs: 5000, memoryMb: 64 } });
  assert.equal(manifest.id, "sample.plugin");
  assert.deepEqual(manifest.capabilities, ["project.read"]);
});
test("rejects traversal, unknown capabilities and unbounded resources", () => {
  const base = { apiVersion: 1, id: "sample.plugin", name: "Sample", entry: "index.cjs", capabilities: [] };
  assert.throws(() => validatePluginManifest({ ...base, entry: "../index.cjs" }), /relative/);
  assert.throws(() => validatePluginManifest({ ...base, capabilities: ["filesystem.root"] }), /capabilities/);
  assert.throws(() => validatePluginManifest({ ...base, resources: { timeoutMs: 999999 } }), /resource/);
});
