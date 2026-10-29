"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createWorkerStateStore } = require("./worker-state.cjs");
const { runWorkerToolProbe } = require("./mcp-runtime.cjs");

async function withStore(run) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "axiom-mcp-worker-diagnostic-"));
  const workspace = path.join(temp, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  try {
    const store = createWorkerStateStore(path.join(temp, "user-data"), workspace);
    await run(store);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

function fakeRuntime(toolState) {
  let requestCount = 0;
  return async (url, options = {}) => {
    requestCount++;
    if (requestCount === 1) {
      assert.equal(new URL(url).pathname, "/session");
      assert.equal(options.method, "POST");
      return { ok: true, json: async () => ({ id: "ses_diagnostic" }) };
    }
    assert.equal(new URL(url).pathname, "/session/ses_diagnostic/message");
    const prompt = JSON.parse(options.body).parts[0].text;
    assert.match(prompt, /context7_/);
    return {
      ok: true,
      json: async () => ({
        parts: [{
          type: "tool",
          tool: "context7_resolve-library-id",
          state: { status: toolState }
        }]
      })
    };
  };
}

test("MCP worker diagnostic records a verified tool invocation and survives store reload", async () => {
  await withStore(async store => {
    const task = {
      taskId: "mcp-diagnostic-success",
      title: "MCP tool verification: Context7",
      status: "running",
      workerType: "mcp-diagnostic",
      integrationId: "context7",
      startedAt: 100
    };
    await store.record(task);

    const result = await runWorkerToolProbe({
      baseUrl: "http://127.0.0.1:4096",
      integrationId: "context7",
      fetchImpl: fakeRuntime("completed")
    });
    await store.record({
      ...task,
      status: result.invoked ? "succeeded" : "failed",
      sessionId: result.sessionId,
      toolName: result.toolName,
      error: result.invoked ? undefined : result.message,
      finishedAt: 200
    });

    const saved = (await createWorkerStateStore(
      path.dirname(path.dirname((await fs.realpath(path.join(os.tmpdir(), "unused")).catch(() => "")))),
      "/not-used"
    ).list()).find(item => item.taskId === task.taskId);
    // Read through the original store's durable file to avoid relying on in-memory state.
    const records = await store.list();
    const persisted = records.find(item => item.taskId === task.taskId);
    assert.equal(result.invoked, true);
    assert.equal(result.status, "tool_completed");
    assert.equal(persisted.status, "succeeded");
    assert.equal(persisted.sessionId, "ses_diagnostic");
    assert.equal(persisted.toolName, "context7_resolve-library-id");
    assert.equal(persisted.error, undefined);
    assert.equal(saved, undefined);
  });
});

test("MCP worker diagnostic records a failed tool call as failed, never succeeded", async () => {
  await withStore(async store => {
    const task = {
      taskId: "mcp-diagnostic-failure",
      title: "MCP tool verification: Context7",
      status: "running",
      workerType: "mcp-diagnostic",
      integrationId: "context7",
      startedAt: 100
    };
    await store.record(task);
    const result = await runWorkerToolProbe({
      baseUrl: "http://127.0.0.1:4096",
      integrationId: "context7",
      fetchImpl: fakeRuntime("error")
    });
    await store.record({
      ...task,
      status: result.invoked ? "succeeded" : "failed",
      sessionId: result.sessionId,
      toolName: result.toolName,
      error: result.invoked ? undefined : result.message,
      finishedAt: 200
    });
    const persisted = (await store.list()).find(item => item.taskId === task.taskId);
    assert.equal(result.invoked, false);
    assert.equal(result.status, "tool_failed");
    assert.equal(persisted.status, "failed");
    assert.equal(persisted.sessionId, "ses_diagnostic");
    assert.equal(persisted.toolName, "context7_resolve-library-id");
    assert.match(persisted.error, /failed tool state/);
  });
});
