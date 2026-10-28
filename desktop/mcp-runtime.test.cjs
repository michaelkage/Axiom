"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { inspectMcpRuntime, normalizeMcpList, normalizeToolIds, extractToolCalls, runWorkerToolProbe } = require("./mcp-runtime.cjs");

test("normalizes Axiom runtime MCP status and tool IDs", () => {
  assert.deepEqual(normalizeMcpList({ data: [{ name: "context7", status: { status: "connected" } }] }), [{ id: "context7", status: "connected", error: "" }]);
  assert.deepEqual(normalizeMcpList({ servers: [null, 7, {}, { name: 42, id: 9, status: {} }, { name: "  github  ", status: { status: "CONNECTED" } }] }), [{ id: "github", status: "connected", error: "" }]);
  assert.deepEqual(normalizeToolIds({ toolIDs: ["context7_resolve-library-id"] }), ["context7_resolve-library-id"]);
  assert.deepEqual(normalizeToolIds({ toolIds: ["valid_tool", 42, null, {}, { id: 7 }, { name: "named_tool" }] }), ["valid_tool", "named_tool"]);
  assert.deepEqual(extractToolCalls({ parts: [{ type: "tool", tool: "context7_resolve-library-id", state: { status: "completed" } }] }), [{ name: "context7_resolve-library-id", state: "completed" }]);
  assert.deepEqual(extractToolCalls({ parts: [null, 3, { type: "tool", tool: 12, name: "fallback_tool", state: {} }, { type: "tool-call", name: "second_tool", state: 7 }] }), [{ name: "fallback_tool", state: "unknown" }, { name: "second_tool", state: "unknown" }]);
});

test("reports connection and tool discovery from runtime endpoints", async () => {
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path === "/global/health") return { ok: true, json: async () => ({ healthy: true, version: "1.19.0" }) };
    if (path === "/mcp") return { ok: true, json: async () => ({ data: [{ name: "context7", status: "connected" }] }) };
    if (path === "/experimental/tool/ids") return { ok: true, json: async () => ({ toolIDs: ["context7_resolve-library-id", "other_search"] }) };
    return { ok: false, status: 404 };
  };
  const result = await inspectMcpRuntime({ baseUrl: "http://127.0.0.1:4096", configuredIds: ["context7", "supabase"], fetchImpl });
  assert.equal(result.runtimeReachable, true);
  assert.equal(result.runtimeVersion, "1.19.0");
  assert.equal(result.runtimeHealthy, true);
  assert.equal(result.servers[0].connected, true);
  assert.deepEqual(result.servers[0].tools, ["context7_resolve-library-id"]);
  assert.equal(result.servers[1].status, "not_reported");
});

test("reports unhealthy runtime state without treating it as unknown", async () => {
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path === "/global/health") return { ok: true, json: async () => ({ healthy: false, version: "1.19.0" }) };
    if (path === "/mcp") return { ok: true, json: async () => ({ data: [{ name: "context7", status: "connected" }] }) };
    if (path === "/experimental/tool/ids") return { ok: true, json: async () => ({ toolIDs: ["context7_resolve-library-id"] }) };
    return { ok: false, status: 404 };
  };
  const result = await inspectMcpRuntime({ baseUrl: "http://127.0.0.1:4096", configuredIds: ["context7"], fetchImpl });
  assert.equal(result.runtimeReachable, true);
  assert.equal(result.runtimeHealthy, false);
  assert.match(result.healthError, /reports an unhealthy runtime/);
});

test("leaves runtime health unknown when a legacy endpoint omits the healthy flag", async () => {
  const fetchImpl = async url => {
    const path = new URL(url).pathname;
    if (path === "/global/health") return { ok: true, json: async () => ({ version: "legacy" }) };
    if (path === "/mcp") return { ok: true, json: async () => ({ data: [] }) };
    if (path === "/experimental/tool/ids") return { ok: true, json: async () => ({ toolIDs: [] }) };
    return { ok: false, status: 404 };
  };
  const result = await inspectMcpRuntime({ baseUrl: "http://127.0.0.1:4096", fetchImpl });
  assert.equal(result.runtimeHealthy, null);
  assert.equal(result.healthError, "");
});

test("worker probe requires a completed MCP tool invocation", async () => {
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ id: "ses_test" }) };
    assert.match(JSON.parse(options.body).parts[0].text, /context7_/);
    return { ok: true, json: async () => ({ parts: [{ type: "tool", tool: "context7_resolve-library-id", state: { status: "completed" } }] }) };
  };
  const result = await runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId: "context7", fetchImpl });
  assert.equal(result.invoked, true);
  assert.equal(result.status, "tool_completed");
  assert.equal(result.toolName, "context7_resolve-library-id");
});

test("worker probe recognizes a completed call after an earlier pending call", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ id: "ses_test" }) };
    return { ok: true, json: async () => ({ parts: [
      { type: "tool", tool: "context7_resolve-library-id", state: { status: "running" } },
      { type: "tool", tool: "context7_get-library-docs", state: { status: "completed" } }
    ] }) };
  };
  const result = await runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId: "context7", fetchImpl });
  assert.equal(result.invoked, true);
  assert.equal(result.status, "tool_completed");
  assert.equal(result.toolName, "context7_get-library-docs");
});

test("worker probe does not count pending or failed calls as successful", async () => {
  for (const state of ["running", "error"]) {
    let calls = 0;
    const fetchImpl = async () => {
      calls++;
      if (calls === 1) return { ok: true, json: async () => ({ id: "ses_test" }) };
      return { ok: true, json: async () => ({ parts: [{ type: "tool", tool: "context7_resolve-library-id", state: { status: state } }] }) };
    };
    const result = await runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId: "context7", fetchImpl });
    assert.equal(result.invoked, false);
    assert.equal(result.status, state === "error" ? "tool_failed" : "tool_incomplete");
  }
});

test("worker probe rejects calls to a different integration", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ id: "ses_test" }) };
    return { ok: true, json: async () => ({ parts: [
      { type: "tool", tool: "github_search_repositories", state: { status: "completed" } }
    ] }) };
  };
  const result = await runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId: "context7", fetchImpl });
  assert.equal(result.invoked, false);
  assert.equal(result.status, "no_mcp_tool_invocation");
  assert.equal(result.toolName, null);
});

test("worker probe rejects malformed integration IDs before contacting the runtime", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("should not be called"); };
  for (const integrationId of ["", "   ", "../github", "context7/extra", "context7 name", 7, null]) {
    await assert.rejects(runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId, fetchImpl }), /valid runtime URL and MCP integration ID/);
  }
  assert.equal(calls, 0);
});

test("worker probe rejects runtime URLs with unsupported schemes or embedded credentials", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error("should not be called"); };
  for (const baseUrl of ["file:///tmp/runtime", "ftp://127.0.0.1:4096", "http://user:secret@127.0.0.1:4096"]) {
    await assert.rejects(runWorkerToolProbe({ baseUrl, integrationId: "context7", fetchImpl }), /valid HTTP\(S\) URL without embedded credentials/);
  }
  assert.equal(calls, 0);
});

test("worker probe rejects missing or non-string session IDs", async () => {
  for (const payload of [{ data: {} }, { id: 42 }, { id: { value: "ses_test" } }, { data: { id: "   " } }]) {
    const fetchImpl = async () => ({ ok: true, json: async () => payload });
    await assert.rejects(
      runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId: "context7", fetchImpl }),
      /no identifiable diagnostic session/
    );
  }
});

test("worker probe reports runtime HTTP failures instead of success", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return { ok: true, json: async () => ({ id: "ses_test" }) };
    return { ok: false, status: 503 };
  };
  await assert.rejects(
    runWorkerToolProbe({ baseUrl: "http://127.0.0.1:4096", integrationId: "context7", fetchImpl }),
    /worker request failed \(HTTP 503\)/
  );
});
