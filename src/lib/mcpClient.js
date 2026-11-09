const PROTOCOL_VERSION = '2025-03-26';
export async function connectMcpHttp(endpoint, { fetchImpl = fetch } = {}) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const call = async (method, params = {}, id = Date.now()) => {
    const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id }), method, params }) });
    if (!response.ok) throw new Error('MCP HTTP ' + response.status);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const text = await response.text();
    const dataLine = text.split(/\r?\n/).find(line => line.startsWith('data:'));
    const payload = text.trim().startsWith('data:') ? dataLine?.slice(5).trim() : text;
    if (!payload) throw new Error('MCP server returned no JSON-RPC response.');
    const message = JSON.parse(payload);
    if (message.error) throw new Error(message.error.message || 'MCP request failed');
    return message.result;
  };
  await call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Axiom', version: '1.0.0' } }, 1);
  await call('notifications/initialized', {}).catch(() => null);
  headers['MCP-Protocol-Version'] = PROTOCOL_VERSION;
  const result = await call('tools/list', {}, 3);
  return { tools: result?.tools || [], call };
}
export async function connectMcpSse(endpoint, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (typeof EventSource === 'undefined') throw new Error('EventSource is not supported in this browser.');
  const source = new EventSource(endpoint);
  const pending = new Map();
  let messageEndpoint = '';
  let nextId = 10;
  let endpointResolve, endpointReject;
  const endpointReady = new Promise((resolve, reject) => { endpointResolve = resolve; endpointReject = reject; });
  const endpointTimer = setTimeout(() => endpointReject(new Error('MCP SSE endpoint event timed out.')), timeoutMs);
  source.addEventListener('endpoint', event => {
    try {
      messageEndpoint = new URL(event.data, endpoint).toString();
      clearTimeout(endpointTimer);
      endpointResolve(messageEndpoint);
    } catch (error) { endpointReject(error); }
  });
  source.addEventListener('message', event => {
    try {
      const message = JSON.parse(event.data);
      if (message.id === undefined || !pending.has(message.id)) return;
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'MCP request failed'));
      else waiter.resolve(message.result);
    } catch { /* Ignore non-JSON server events. */ }
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      endpointReject(new Error('MCP SSE connection closed.'));
      for (const waiter of pending.values()) waiter.reject(new Error('MCP SSE connection closed.'));
      pending.clear();
    }
  };
  const post = async (message, waitForResult) => {
    const target = await endpointReady;
    let responsePromise;
    if (waitForResult) {
      responsePromise = new Promise((resolve, reject) => {
        pending.set(message.id, { resolve, reject });
        setTimeout(() => {
          if (pending.has(message.id)) {
            pending.delete(message.id);
            reject(new Error('MCP request timed out: ' + message.method));
          }
        }, timeoutMs);
      });
    }
    const response = await fetchImpl(target, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': PROTOCOL_VERSION },
      body: JSON.stringify(message)
    });
    if (!response.ok) {
      pending.delete(message.id);
      throw new Error('MCP SSE message POST returned HTTP ' + response.status);
    }
    if (!waitForResult) return null;
    const body = await response.text();
    if (body.trim()) {
      try {
        const payload = JSON.parse(body);
        if (payload.id !== undefined && pending.has(payload.id)) {
          const waiter = pending.get(payload.id);
          pending.delete(payload.id);
          if (payload.error) waiter.reject(new Error(payload.error.message || 'MCP request failed'));
          else waiter.resolve(payload.result);
        }
      } catch { /* The server may deliver the JSON-RPC reply over SSE instead. */ }
    }
    return responsePromise;
  };
  const call = async (method, params = {}) => {
    const id = nextId++;
    return await post({ jsonrpc: '2.0', id, method, params }, true);
  };
  try {
    await call('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'Axiom', version: '1.0.0' } });
    await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false);
    const result = await call('tools/list', {});
    return { tools: result?.tools || [], call, close: () => source.close() };
  } catch (error) {
    source.close();
    throw error;
  }
}

