"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const { createOpenCodeTelemetryBridge, normalizeCompletedMessage } = require("./opencode-telemetry-bridge.cjs");

const completed = {
  type: "message.updated",
  properties: { info: {
    id: "message-1", role: "assistant", providerID: "openai", modelID: "gpt-test",
    sessionID: "session-1", time: { created: 1000, completed: 2500 },
    tokens: { input: 100, output: 40, cache: { read: 10 } }, cost: 0.002
  } }
};

test("normalizes completed assistant model usage from actual runtime events", () => {
  const metric = normalizeCompletedMessage(completed);
  assert.equal(metric.providerId, "openai");
  assert.equal(metric.modelId, "gpt-test");
  assert.equal(metric.durationMs, 1500);
  assert.equal(metric.inputTokens, 110);
  assert.equal(metric.outputTokens, 40);
  assert.equal(metric.estimatedCostUsd, 0.002);
  assert.equal(normalizeCompletedMessage({ type: "message.updated", properties: { info: { role: "user" } } }), null);
});

test("consumes OpenCode SSE events and records each completed message once", async () => {
  const events = [];
  const telemetry = { record: metric => { events.push(metric); return metric; } };
  let requestCount = 0;
  const fetch = async (_url, options) => {
    requestCount++;
    const payload = "data: " + JSON.stringify(completed) + String.fromCharCode(10, 10);
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      }
    });
    return { ok: true, status: 200, body };
  };
  const bridge = createOpenCodeTelemetryBridge({ telemetry, fetch });
  bridge.start("http://127.0.0.1:4096");
  await new Promise(resolve => setTimeout(resolve, 30));
  await bridge.stop();
  assert.equal(requestCount, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].id, "message-1");
});
