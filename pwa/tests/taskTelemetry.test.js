import test from "node:test";
import assert from "node:assert/strict";
import { estimateTaskUsage, estimateTaskCost, isTaskBudgetExceeded } from "../src/lib/taskTelemetry.js";

test("aggregates token and latency metrics across task turns", () => {
  const usage = estimateTaskUsage([{ type: "metrics", metrics: { promptTokens: 100, generatedTokens: 50, firstTokenMs: 220, totalMs: 900 } }, { type: "metrics", metrics: { promptTokens: 40, generatedTokens: 20, totalMs: 400 } }]);
  assert.equal(usage.totalTokens, 210);
  assert.equal(usage.firstTokenLatencyMs, 220);
  assert.equal(usage.totalLatencyMs, 1300);
});

test("estimates task cost and detects budget overruns", () => {
  const usage = { inputTokens: 1000000, outputTokens: 500000 };
  const rates = { input: 1, output: 2 };
  assert.equal(estimateTaskCost(usage, rates).totalCost, 2);
  assert.equal(isTaskBudgetExceeded(usage, 1.99, rates), true);
  assert.equal(isTaskBudgetExceeded(usage, 2, rates), false);
});
