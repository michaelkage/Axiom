"use strict";

// OpenCode's MCP status and tool-ID APIs are versioned differently across releases.
// Probe known API shapes rather than guessing that a saved config means "connected".
const REQUEST_TIMEOUT_MS = 5000;

async function requestJson(baseUrl, route, fetchImpl = fetch) {
  const url = new URL(route, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  if (!response.ok) throw new Error("OpenCode API returned HTTP " + response.status);
  return response.json();
}

function normalizeMcpList(payload) {
  const list = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.servers) ? payload.servers : [];
  return list.map(item => ({
    id: String(item.name || item.id || ""),
    status: String(item.status?.status || item.status || "unknown").toLowerCase(),
    error: typeof item.error === "string" && item.error ? "OpenCode reported an MCP server error; check authentication and runtime logs." : ""
  })).filter(item => item.id);
}

function normalizeToolIds(payload) {
  const values = Array.isArray(payload) ? payload
    : Array.isArray(payload?.toolIDs) ? payload.toolIDs
    : Array.isArray(payload?.toolIds) ? payload.toolIds
    : Array.isArray(payload?.data) ? payload.data : [];
  return values.map(item => typeof item === "string" ? item : item?.id || item?.name || "").filter(Boolean);
}

async function firstSuccessful(baseUrl, routes, fetchImpl) {
  let lastError;
  for (const route of routes) {
    try { return { route, value: await requestJson(baseUrl, route, fetchImpl) }; }
    catch (error) { lastError = error; }
  }
  throw lastError || new Error("OpenCode diagnostic endpoint unavailable.");
}

async function inspectMcpRuntime({ baseUrl, configuredIds = [], fetchImpl = fetch } = {}) {
  if (!baseUrl) return { runtimeReachable: false, servers: [], toolIds: [], error: "OpenCode runtime URL is not available." };
  let runtimeVersion = null, runtimeHealthy = null;
  try {
    const health = await firstSuccessful(baseUrl, ["global/health", "api/global/health"], fetchImpl);
    runtimeVersion = typeof health.value?.version === "string" ? health.value.version : null;
    runtimeHealthy = health.value?.healthy === true;
  } catch { /* Older OpenCode builds may not expose the health endpoint. */ }
  let mcpResult;
  try {
    mcpResult = await firstSuccessful(baseUrl, ["mcp", "api/mcp"], fetchImpl);
  } catch {
    return { runtimeReachable: false, servers: [], toolIds: [], error: "Could not read MCP status from the bundled OpenCode runtime. Check runtime compatibility and logs." };
  }

  let toolIds = [];
  let toolDiscoveryError = "";
  try {
    const tools = await firstSuccessful(baseUrl, ["experimental/tool/ids", "api/experimental/tool/ids"], fetchImpl);
    toolIds = normalizeToolIds(tools.value);
  } catch {
    toolDiscoveryError = "The runtime MCP status endpoint responded, but this OpenCode version did not expose a recognized tool-ID endpoint.";
  }

  const servers = normalizeMcpList(mcpResult.value);
  const known = new Set(servers.map(server => server.id));
  const configured = [...new Set(configuredIds)].map(id => {
    const server = servers.find(item => item.id === id);
    const prefix = id.replace(/[^a-zA-Z0-9_-]/g, "_") + "_";
    const tools = toolIds.filter(tool => tool.startsWith(prefix));
    if (!server) return { id, status: "not_reported", connected: false, tools, error: "Server is configured in Axiom but not reported by OpenCode." };
    const connected = server.status === "connected";
    return { id, status: server.status, connected, tools, error: server.error || (connected && tools.length === 0 && !toolDiscoveryError ? "Connected, but no tools from this server were discovered." : "") };
  });
  return {
    runtimeReachable: true,
    runtimeVersion,
    runtimeHealthy,
    servers: configured,
    toolIds,
    toolDiscoveryAvailable: !toolDiscoveryError,
    error: toolDiscoveryError,
    apiRoute: mcpResult.route
  };
}

function extractToolCalls(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : Array.isArray(message?.data?.parts) ? message.data.parts : [];
  return parts.filter(part => part && (part.type === "tool" || part.type === "tool-call" || part.tool))
    .map(part => ({ name: String(part.tool || part.name || part.call?.name || ""), state: part.state?.status || part.state || "unknown" }))
    .filter(part => part.name);
}

async function runWorkerToolProbe({ baseUrl, integrationId, fetchImpl = fetch } = {}) {
  if (!baseUrl || !integrationId) throw new Error("Runtime URL and integration ID are required.");
  const sessionResponse = await fetchImpl(new URL("session", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Axiom MCP tool verification" }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  if (!sessionResponse.ok) throw new Error("OpenCode could not create a diagnostic worker session (HTTP " + sessionResponse.status + ").");
  const sessionPayload = await sessionResponse.json();
  const sessionId = sessionPayload.id || sessionPayload.data?.id;
  if (!sessionId) throw new Error("OpenCode created no identifiable diagnostic session.");
  const expectedPrefix = integrationId.replace(/[^a-zA-Z0-9_-]/g, "_") + "_";
  const prompt = "This is an Axiom MCP integration verification. Use exactly one available tool whose name starts with " + expectedPrefix + " to perform a harmless read-only lookup. Do not use shell, edit files, or perform writes. If no such tool is available, state that clearly. Return a concise result.";
  const messageResponse = await fetchImpl(new URL("session/" + encodeURIComponent(sessionId) + "/message", baseUrl.endsWith("/") ? baseUrl : baseUrl + "/"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ parts: [{ type: "text", text: prompt }] }), signal: AbortSignal.timeout(120000)
  });
  if (!messageResponse.ok) throw new Error("OpenCode worker request failed (HTTP " + messageResponse.status + ").");
  const message = await messageResponse.json();
  const calls = extractToolCalls(message);
  const invoked = calls.find(call => call.name.startsWith(expectedPrefix));
  return {
    sessionId,
    invoked: !!invoked,
    toolName: invoked?.name || null,
    toolCalls: calls,
    status: invoked ? "tool_invoked" : "no_mcp_tool_invocation",
    message: invoked ? "The OpenCode worker returned an MCP tool-call part for " + invoked.name + "." : "The worker response contained no invocation for this integration. Check model configuration, authentication, tool discovery, and worker output."
  };
}

module.exports = { inspectMcpRuntime, normalizeMcpList, normalizeToolIds, extractToolCalls, runWorkerToolProbe };
