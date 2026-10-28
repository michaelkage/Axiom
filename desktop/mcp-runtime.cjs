"use strict";

const REQUEST_TIMEOUT_MS = 5000;

async function requestJson(baseUrl, route, fetchImpl = fetch) {
  const url = new URL(route, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error("Axiom runtime API returned HTTP " + response.status);
  return response.json();
}

function normalizeMcpList(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.servers) ? payload.servers : [];
  return list.filter(item => item && typeof item === "object" && !Array.isArray(item)).map(item => {
    const id = typeof item.name === "string" && item.name.trim() ? item.name.trim() : typeof item.id === "string" ? item.id.trim() : "";
    const rawStatus = typeof item.status === "string" ? item.status : typeof item.status?.status === "string" ? item.status.status : "unknown";
    return {
      id,
      status: rawStatus.toLowerCase(),
      error: typeof item.error === "string" && item.error ? "Axiom runtime reported an MCP server error; check authentication and runtime logs." : ""
    };
  }).filter(item => item.id);
}

function normalizeToolIds(payload) {
  const values = Array.isArray(payload) ? payload
    : Array.isArray(payload?.toolIDs) ? payload.toolIDs
    : Array.isArray(payload?.toolIds) ? payload.toolIds
    : Array.isArray(payload?.data) ? payload.data : [];
  return values.map(item => typeof item === "string" ? item : typeof item?.id === "string" ? item.id : typeof item?.name === "string" ? item.name : "").filter(item => item.length > 0);
}

async function firstSuccessful(baseUrl, routes, fetchImpl) {
  let lastError;
  for (const route of routes) {
    try { return { route, value: await requestJson(baseUrl, route, fetchImpl) }; }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error("Axiom runtime diagnostic endpoint unavailable.");
}

async function inspectMcpRuntime({ baseUrl, configuredIds = [], fetchImpl = fetch } = {}) {
  if (!baseUrl) return { runtimeReachable: false, servers: [], toolIds: [], error: "Axiom runtime URL is not available." };
  let runtimeVersion = null, runtimeHealthy = null;
  try {
    const health = await firstSuccessful(baseUrl, ["global/health", "api/global/health"], fetchImpl);
    runtimeVersion = typeof health.value?.version === "string" ? health.value.version : null;
    runtimeHealthy = typeof health.value?.healthy === "boolean" ? health.value.healthy : null;
  } catch { /* Older runtime builds may not expose the health endpoint. */ }
  let mcpResult;
  try {
    mcpResult = await firstSuccessful(baseUrl, ["mcp", "api/mcp"], fetchImpl);
  } catch {
    return { runtimeReachable: false, servers: [], toolIds: [], error: "Could not read MCP status from the bundled Axiom runtime. Check runtime compatibility and logs." };
  }

  let toolIds = [];
  let toolDiscoveryError = "";
  try {
    const tools = await firstSuccessful(baseUrl, ["experimental/tool/ids", "api/experimental/tool/ids"], fetchImpl);
    toolIds = normalizeToolIds(tools.value);
  } catch {
    toolDiscoveryError = "The runtime MCP status endpoint responded, but this runtime version did not expose a recognized tool-ID endpoint.";
  }

  const servers = normalizeMcpList(mcpResult.value);
  const configured = [...new Set(configuredIds)].map(id => {
    const server = servers.find(item => item.id === id);
    const prefix = id.replace(/[^a-zA-Z0-9_-]/g, "_") + "_";
    const tools = toolIds.filter(tool => tool.startsWith(prefix));
    if (!server) return { id, status: "not_reported", connected: false, tools, error: "Server is configured in Axiom but not reported by the Axiom runtime." };
    const connected = server.status === "connected";
    return { id, status: server.status, connected, tools, error: server.error || (connected && tools.length === 0 && !toolDiscoveryError ? "Connected, but no tools from this server were discovered." : "") };
  });
  return {
    runtimeReachable: true,
    runtimeVersion,
    runtimeHealthy,
    healthError: runtimeHealthy === false ? "The Axiom runtime health endpoint reports an unhealthy runtime. Check runtime logs and initialization." : "",
    servers: configured,
    toolIds,
    toolDiscoveryAvailable: !toolDiscoveryError,
    error: toolDiscoveryError,
    apiRoute: mcpResult.route
  };
}

function extractToolCalls(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : Array.isArray(message?.data?.parts) ? message.data.parts : [];
  return parts.filter(part => part && typeof part === "object" && !Array.isArray(part) && (part.type === "tool" || part.type === "tool-call" || typeof part.tool === "string"))
    .map(part => {
      const name = typeof part.tool === "string" && part.tool.trim() ? part.tool.trim() : typeof part.name === "string" && part.name.trim() ? part.name.trim() : typeof part.call?.name === "string" ? part.call.name.trim() : "";
      const rawState = typeof part.state === "string" ? part.state : typeof part.state?.status === "string" ? part.state.status : "unknown";
      return { name, state: rawState.toLowerCase() };
    })
    .filter(part => part.name);
}

async function runWorkerToolProbe({ baseUrl, integrationId, fetchImpl = fetch } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim() || typeof integrationId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(integrationId)) throw new Error("A valid runtime URL and MCP integration ID are required.");
  try { const parsedBase = new URL(baseUrl); if (!["http:", "https:"].includes(parsedBase.protocol) || parsedBase.username || parsedBase.password) throw new Error(); }
  catch { throw new Error("The Axiom runtime URL must be a valid HTTP(S) URL without embedded credentials."); }
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  const sessionResponse = await fetchImpl(new URL("session", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Axiom MCP tool verification" }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!sessionResponse.ok) throw new Error("Axiom could not create a diagnostic worker session (HTTP " + sessionResponse.status + ").");
  const sessionPayload = await sessionResponse.json();
  const sessionId = sessionPayload.id || sessionPayload.data?.id;
  if (!sessionId) throw new Error("Axiom runtime created no identifiable diagnostic session.");
  const expectedPrefix = integrationId.replace(/[^a-zA-Z0-9_-]/g, "_") + "_";
  const prompt = "This is an Axiom MCP integration verification. Use exactly one available tool whose name starts with " + expectedPrefix + " to perform a harmless read-only lookup. Do not use shell, edit files, or perform writes. If no such tool is available, state that clearly. Return a concise result.";
  const messageResponse = await fetchImpl(new URL("session/" + encodeURIComponent(sessionId) + "/message", base), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }), signal: AbortSignal.timeout(120000)
  });
  if (!messageResponse.ok) throw new Error("Axiom worker request failed (HTTP " + messageResponse.status + ").");
  const message = await messageResponse.json();
  const calls = extractToolCalls(message);
  const matchingCalls = calls.filter(call => call.name.startsWith(expectedPrefix));
  const matching = matchingCalls.find(call => ["completed", "success", "succeeded"].includes(call.state))
    || matchingCalls.find(call => ["error", "failed", "cancelled", "canceled"].includes(call.state))
    || matchingCalls.at(-1);
  const completed = matching && ["completed", "success", "succeeded"].includes(matching.state);
  const failed = matching && ["error", "failed", "cancelled", "canceled"].includes(matching.state);
  return {
    sessionId,
    invoked: !!completed,
    toolName: matching?.name || null,
    toolState: matching?.state || null,
    toolCalls: calls,
    status: completed ? "tool_completed" : failed ? "tool_failed" : matching ? "tool_incomplete" : "no_mcp_tool_invocation",
    message: completed
      ? "The Axiom worker completed an MCP tool call for " + matching.name + "."
      : failed
        ? "The worker attempted " + matching.name + " but the runtime reported a failed tool state. Check integration authentication and runtime logs."
        : matching
          ? "The worker emitted an MCP tool call for " + matching.name + ", but did not report a completed result."
          : "The worker response contained no invocation for this integration. Check model configuration, authentication, tool discovery, and worker output."
  };
}

module.exports = { inspectMcpRuntime, normalizeMcpList, normalizeToolIds, extractToolCalls, runWorkerToolProbe };
