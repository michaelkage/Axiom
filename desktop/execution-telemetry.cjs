"use strict";

const MAX_EVENTS = 5000;
const MAX_ID = 160;
const SECRET_KEYS = /token|secret|password|authorization|api[-_]?key|credential/i;
function safeText(value, max = 500) {
  return typeof value === "string" ? value.replace(/[\r\n\0]/g, " ").slice(0, max) : "";
}
function sanitizeMetadata(value, depth = 0) {
  if (depth > 4 || value == null) return null;
  if (typeof value === "string") return safeText(value, 1000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map(item => sanitizeMetadata(item, depth + 1));
  if (typeof value !== "object") return null;
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 50)) {
    if (SECRET_KEYS.test(key)) continue;
    output[safeText(key, 80)] = sanitizeMetadata(item, depth + 1);
  }
  return output;
}
function createExecutionTelemetry(options = {}) {
  const now = options.now || (() => Date.now());
  const maxEvents = Math.min(Math.max(Number(options.maxEvents) || MAX_EVENTS, 100), MAX_EVENTS);
  const events = [];
  const health = new Map();
  function record(input) {
    if (!input || typeof input !== "object" || typeof input.providerId !== "string" || !/^[a-zA-Z0-9._:-]{1,160}$/.test(input.providerId)) throw new TypeError("Telemetry provider ID is invalid.");
    const durationMs = Number(input.durationMs);
    if (!Number.isFinite(durationMs) || durationMs < 0 || durationMs > 3600000) throw new TypeError("Telemetry duration is invalid.");
    const success = input.success === true;
    const event = Object.freeze({
      id: safeText(input.id, MAX_ID) || String(events.length + 1),
      providerId: input.providerId,
      modelId: safeText(input.modelId, MAX_ID),
      operation: safeText(input.operation, 80),
      success, durationMs, inputTokens: boundedCount(input.inputTokens),
      outputTokens: boundedCount(input.outputTokens), estimatedCostUsd: boundedCost(input.estimatedCostUsd),
      at: now(), metadata: sanitizeMetadata(input.metadata)
    });
    events.push(event);
    if (events.length > maxEvents) events.splice(0, events.length - maxEvents);
    const prior = health.get(input.providerId) || { samples: 0, failures: 0, latencyEwmaMs: null, lastSuccessAt: null, lastFailureAt: null };
    prior.samples = Math.min(prior.samples + 1, 1000000);
    if (success) prior.lastSuccessAt = event.at; else prior.failures++, prior.lastFailureAt = event.at;
    prior.latencyEwmaMs = prior.latencyEwmaMs === null ? durationMs : prior.latencyEwmaMs * 0.8 + durationMs * 0.2;
    health.set(input.providerId, prior);
    return event;
  }
  function snapshot() { return { events: events.map(event => ({ ...event })), providers: [...health].map(([providerId, value]) => ({ providerId, ...value })) }; }
  function rank(candidates, requirements = {}) {
    if (!Array.isArray(candidates)) throw new TypeError("Routing candidates must be an array.");
    return candidates.filter(candidate => candidate && candidate.available === true &&
      (!requirements.capabilities || requirements.capabilities.every(capability => candidate.capabilities?.includes(capability))) &&
      (!requirements.maxCostUsd || Number(candidate.costUsdPer1kTokens ?? Infinity) <= requirements.maxCostUsd))
      .map(candidate => {
        const state = health.get(candidate.providerId) || { samples: 0, failures: 0, latencyEwmaMs: null };
        const failureRate = state.samples ? state.failures / state.samples : 0;
        const latency = state.latencyEwmaMs ?? Number(candidate.latencyMs ?? 10000);
        const cost = Number(candidate.costUsdPer1kTokens ?? 0);
        return { ...candidate, routingScore: latency * 0.55 + failureRate * 10000 + cost * 1000, observedFailureRate: failureRate, observedLatencyMs: state.latencyEwmaMs };
      }).sort((a, b) => a.routingScore - b.routingScore || String(a.providerId).localeCompare(String(b.providerId)));
  }
  return Object.freeze({ record, snapshot, rank });
}
function boundedCount(value) { const n = Number(value ?? 0); return Number.isSafeInteger(n) && n >= 0 && n <= 100000000 ? n : 0; }
function boundedCost(value) { const n = Number(value ?? 0); return Number.isFinite(n) && n >= 0 && n <= 100000 ? n : 0; }
module.exports = { createExecutionTelemetry, sanitizeMetadata, MAX_EVENTS };
