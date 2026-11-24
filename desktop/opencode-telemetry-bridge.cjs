"use strict";

const { setTimeout: delay } = require("node:timers/promises");

function normalizeCompletedMessage(event) {
  if (!event || event.type !== "message.updated") return null;
  const info = event.properties?.info || event.properties?.message || event.info;
  if (!info || info.role !== "assistant" || !info.id || !info.time?.completed) return null;
  const tokens = info.tokens || {};
  const inputTokens = Number(tokens.input ?? 0) + Number(tokens.cache?.read ?? 0);
  const outputTokens = Number(tokens.output ?? 0);
  const cost = Number(info.cost ?? 0);
  const started = Number(info.time.created ?? info.time.started ?? 0);
  const completed = Number(info.time.completed);
  const durationMs = started > 0 && completed >= started ? completed - started : 0;
  if (!info.providerID || !info.modelID || !Number.isFinite(durationMs) || durationMs < 0 ||
      !Number.isSafeInteger(inputTokens) || inputTokens < 0 ||
      !Number.isSafeInteger(outputTokens) || outputTokens < 0 ||
      !Number.isFinite(cost) || cost < 0) return null;
  return {
    id: String(info.id).slice(0, 160),
    providerId: String(info.providerID).slice(0, 160),
    modelId: String(info.modelID).slice(0, 160),
    operation: "chat.completion",
    success: !info.error,
    durationMs,
    inputTokens,
    outputTokens,
    estimatedCostUsd: cost,
    metadata: { sessionId: String(info.sessionID || "").slice(0, 160), finish: String(info.finish || "") }
  };
}

function createOpenCodeTelemetryBridge(options = {}) {
  if (!options.telemetry || typeof options.telemetry.record !== "function") throw new TypeError("A telemetry recorder is required.");
  const fetchImpl = options.fetch || globalThis.fetch;
  const onError = options.onError || (() => {});
  const onMetric = options.onMetric || (() => {});
  const seen = new Set();
  let controller = null;
  let running = false;
  let task = null;

  async function consume(response, signal) {
    if (!response.ok || !response.body) throw new Error("OpenCode event stream returned HTTP " + response.status + ".");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines = [];
    const dispatch = () => {
      if (!dataLines.length) return;
      const raw = dataLines.join("\n");
      dataLines = [];
      let event;
      try { event = JSON.parse(raw); } catch { return; }
      const metric = normalizeCompletedMessage(event);
      if (!metric || seen.has(metric.id)) return;
      seen.add(metric.id);
      if (seen.size > 10000) seen.delete(seen.values().next().value);
      const recorded = options.telemetry.record(metric);
      try { onMetric(recorded); } catch {}
    };
    try {
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > 1024 * 1024) throw new Error("OpenCode event frame exceeded the 1 MiB limit.");
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line) { dispatch(); continue; }
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
      }
      if (buffer.startsWith("data:")) dataLines.push(buffer.slice(5).trimStart());
      dispatch();
    } finally {
      try { await reader.cancel(); } catch {}
    }
  }

  async function run(baseUrl, signal) {
    let retry = 500;
    while (!signal.aborted) {
      try {
        const url = new URL("/event", baseUrl);
        const response = await fetchImpl(url.href, { headers: { Accept: "text/event-stream" }, signal });
        await consume(response, signal);
        retry = 500;
      } catch (error) {
        if (signal.aborted) break;
        try { onError(error); } catch {}
        await delay(retry, undefined, { signal }).catch(() => {});
        retry = Math.min(retry * 2, 10000);
      }
    }
  }

  function start(baseUrl) {
    if (running) return false;
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("OpenCode telemetry endpoint must use HTTP or HTTPS.");
    controller = new AbortController();
    running = true;
    task = run(url.href, controller.signal).finally(() => { running = false; controller = null; task = null; });
    return true;
  }

  async function stop() {
    if (!controller) return;
    controller.abort();
    try { await task; } catch {}
  }

  return Object.freeze({ start, stop, isRunning: () => running });
}

module.exports = { createOpenCodeTelemetryBridge, normalizeCompletedMessage };
