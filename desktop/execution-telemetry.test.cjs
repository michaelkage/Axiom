"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createExecutionTelemetry } = require("./execution-telemetry.cjs");

test("records bounded real execution measurements and strips secret metadata", () => {
  let time = 1000;
  const telemetry = createExecutionTelemetry({ now: () => time++ });
  telemetry.record({ providerId: "local", modelId: "model-a", success: false, durationMs: 900, inputTokens: 20, metadata: { apiKey: "do-not-store", route: "fallback" } });
  telemetry.record({ providerId: "remote", success: true, durationMs: 300, outputTokens: 10 });
  const snapshot = telemetry.snapshot();
  assert.equal(snapshot.events[0].metadata.apiKey, undefined);
  assert.equal(snapshot.providers.find(item => item.providerId === "local").failures, 1);
});
test("routes only to available capability-compatible candidates and learns provider health", () => {
  const telemetry = createExecutionTelemetry();
  telemetry.record({ providerId: "slow", success: false, durationMs: 10000 });
  const ranked = telemetry.rank([
    { providerId: "slow", available: true, capabilities: ["tools"], latencyMs: 100 },
    { providerId: "fast", available: true, capabilities: ["tools"], latencyMs: 200 },
    { providerId: "missing", available: false, capabilities: ["tools"] }
  ], { capabilities: ["tools"] });
  assert.equal(ranked[0].providerId, "fast");
  assert.equal(ranked.length, 2);
});
