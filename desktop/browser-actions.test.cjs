"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBrowserAction, buildBrowserActionScript } = require("./browser-actions.cjs");

test("normalizes click, fill and select actions", () => {
  assert.deepEqual(normalizeBrowserAction({ type: "click", target: "Save" }), { type: "click", target: "Save" });
  assert.deepEqual(normalizeBrowserAction({ type: "fill", target: "Email", value: "person@example.com" }), { type: "fill", target: "Email", value: "person@example.com" });
  assert.match(buildBrowserActionScript({ type: "select", target: "Plan", value: "pro" }), /requested option value is not available/);
});

test("rejects unknown action types, empty selectors and oversized values", () => {
  assert.throws(() => normalizeBrowserAction({ type: "submit", target: "Save" }), /supported browser action/i);
  assert.throws(() => normalizeBrowserAction({ type: "click", target: " " }), /target/i);
  assert.throws(() => normalizeBrowserAction({ type: "fill", target: "Search", value: "x".repeat(4001) }), /4000 characters/i);
});

test("action script JSON-encodes user strings instead of interpolating them into executable source", () => {
  const script = buildBrowserActionScript({ type: "fill", target: "Search", value: "';window.location='https://attacker.example';//" });
  assert.ok(script.includes(JSON.stringify("';window.location='https://attacker.example';//")));
  assert.ok(!script.includes("eval("));
});
