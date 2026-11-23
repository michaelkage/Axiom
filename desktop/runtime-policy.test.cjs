"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRuntimePermissionRules, effectFor } = require("./runtime-policy.cjs");

const policy = {
  "filesystem.read": "allow",
  "filesystem.write": "approval-required",
  "shell.execute": "approval-required",
  "network.request": "deny",
  "mcp.invoke": "approval-required",
  "git.push": "deny",
  "deployment.publish": "approval-required",
  "plugin.execute": "approval-required"
};

test("runtime policy translates workspace decisions into OpenCode permission effects", () => {
  const rules = buildRuntimePermissionRules({ policy, mcpServerIds: ["github", "supabase"] });
  const find = (action, resource = "*") => rules.find(rule => rule.action === action && rule.resource === resource);
  assert.equal(find("read").effect, "allow");
  assert.equal(find("edit").effect, "ask");
  assert.equal(find("shell").effect, "ask");
  assert.equal(find("shell", "git push *").effect, "deny");
  assert.equal(find("webfetch").effect, "deny");
  assert.equal(find("websearch").effect, "deny");
  assert.equal(find("github_*").effect, "ask");
  assert.equal(find("supabase_*").effect, "ask");
  assert.equal(find("opencode_list_mcp_resources").effect, "ask");
  assert.equal(find("read", "*.env").effect, "deny");
  assert.equal(find("external_directory").effect, "deny");
});

test("unknown and malformed policy decisions fail closed", () => {
  assert.equal(effectFor({}, "shell.execute"), "deny");
  assert.equal(effectFor({ "shell.execute": "unexpected" }, "shell.execute"), "deny");
  const rules = buildRuntimePermissionRules({ policy: null, mcpServerIds: ["bad/id", "github"] });
  assert.equal(rules.find(rule => rule.action === "shell").effect, "deny");
  assert.equal(rules.some(rule => rule.action === "bad_id_*"), false);
  assert.equal(rules.find(rule => rule.action === "github_*").effect, "deny");
});
