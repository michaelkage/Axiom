"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectMcpRuntime, normalizeMcpList, normalizeToolIds, extractToolCalls, runWorkerToolProbe } = require("./mcp-runtime.cjs");

test("normalizes OpenCode MCP status and tool IDs", () => {
  assert.deepEqual(normalizeMcpList({ data: [{ name: "context7", status: { status: "connected" } }] }), [{ id: "context7", status: "connected", error: "" }]);
  assert.deepEqual(normalizeToolIds({ toolIDs: ["context7_resolve-library-id"] }), ["context7_resolve-library-id"]);
  assert.deepEqual(extractToolCalls({ parts: [{ type: "tool", tool: "context7_resolve-library-id", state: { status: "completed" } }] }), [{ name: "context7_resolve-library-id", state: "completed" }]);
});

test("reports connection and tool discovery from runtime endpoints", async () => {
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path === "/mcp") return { ok: true, json: async () => ({ data: [{ name: "context7", status: "connected" }] }) };
    if (path === "/experimental/tool/ids") return { ok: true, json: async () => ({ toolIDs: ["context7_resolve-library-id", "other_search"] }) };
    return { ok: false, status: 404 };
  };
  const result = await inspectMcpRuntime({ baseUrl: "http://127.0.0.1:4096", configuredIds: ["context7", "supabase"], fetchImpl });
  assert.equal(result.runtimeReachable, true);
  assert.equal(result.servers[0].connected, true);
  assert.deepEqual(result.servers[0].tools, ["context7_resolve-library-id"]);
  assert.equal(result.servers[1].status, "not_reported");
});

test("worker probe only succeeds when response includes an MCP tool invocation", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ id: "ses_test" }) };
    assert.match(JSON.parse(options.body).parts[0].text, /context7_/);
    return { ok: true, json: async () => ({ parts: [{ type: "tool", tool: "context7_resolve-library-id", state: { status: "completed" } }] }) };
  };
  const result = await runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId: "context7", fetchImpl });
  assert.equal(result.invoked, true);
  assert.equal(result.toolName, "context7_resolve-library-id");
});
