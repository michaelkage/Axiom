const DEFAULT_RATES_PER_MILLION = Object.freeze({ input: 0, output: 0 });

export function estimateTaskUsage(events = []) {
  let inputTokens = 0;
  let outputTokens = 0;
  let firstTokenLatencyMs = null;
  let totalLatencyMs = 0;
  let requestCount = 0;
  for (const event of events) {
    if (event?.type !== "metrics" || !event.metrics) continue;
    const metrics = event.metrics;
    inputTokens += Math.max(0, Number(metrics.promptTokens) || 0);
    outputTokens += Math.max(0, Number(metrics.generatedTokens) || 0);
    if (firstTokenLatencyMs === null && Number.isFinite(Number(metrics.firstTokenMs))) firstTokenLatencyMs = Number(metrics.firstTokenMs);
    totalLatencyMs += Math.max(0, Number(metrics.totalMs) || 0);
    requestCount += 1;
  }
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, firstTokenLatencyMs, totalLatencyMs, requestCount };
}

export function estimateTaskCost(usage, rates = DEFAULT_RATES_PER_MILLION) {
  const inputRate = Number(rates.input);
  const outputRate = Number(rates.output);
  if (!Number.isFinite(inputRate) || inputRate < 0 || !Number.isFinite(outputRate) || outputRate < 0) {
    throw new TypeError("Token rates must be finite, non-negative USD per million tokens.");
  }
  const inputCost = (Math.max(0, Number(usage?.inputTokens) || 0) / 1_000_000) * inputRate;
  const outputCost = (Math.max(0, Number(usage?.outputTokens) || 0) / 1_000_000) * outputRate;
  return { inputCost, outputCost, totalCost: inputCost + outputCost, currency: "USD", estimated: true };
}

export function isTaskBudgetExceeded(usage, budgetUsd, rates) {
  if (!Number.isFinite(budgetUsd) || budgetUsd < 0) throw new TypeError("Task budget must be a non-negative USD amount.");
  return estimateTaskCost(usage, rates).totalCost > budgetUsd;
}
