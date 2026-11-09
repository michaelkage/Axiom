const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

function parseJsonRpcResponse(text, contentType) {
  if (!text.trim()) return undefined;
  let payload = text.trim();
  if (contentType?.includes('text/event-stream') || payload.startsWith('event:') || payload.startsWith('data:')) {
    const events = payload.split(/\r?\n\r?\n/);
    const data = [];
    for (const event of events) {
      const lines = event.split(/\r?\n/).filter(line => line.startsWith('data:'));
      if (lines.length) data.push(lines.map(line => line.slice(5).trimStart()).join('\n'));
    }
    payload = data.find(Boolean) || '';
  }
  if (!payload) return undefined;
  const message = JSON.parse(payload);
  if (message.error) throw new Error(message.error.message || 'MCP request failed');
  if (!Object.prototype.hasOwnProperty.call(message, 'result')) {
    throw new Error('MCP JSON-RPC response is missing its result.');
  }
  return message.result;
}

export async function connectMcpHttp(endpoint, { fetchImpl = fetch, token = '' } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...(token ? { Authorization: 'Bearer ' + token } : {})
  };
  let nextId = 2;
  let closed = false;
  const call = async (method, params = {}, id) => {
    if (closed) throw new Error('MCP connection is closed.');
    const notification = method.startsWith('notifications/');
    const requestId = notification ? undefined : (id ?? nextId++);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, params })
    });
    if (!response.ok) throw new Error('MCP HTTP ' + response.status);
    const sessionId = response.headers.get('mcp-session-id');
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;
    const contentType = response.headers.get('content-type') || '';
    const body = await response.text();
    if (notification || response.status === 202) return null;
    const result = parseJsonRpcResponse(body, contentType);
    if (result === undefined) throw new Error('MCP server returned no JSON-RPC response.');
    return result;
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    if (headers['Mcp-Session-Id']) {
      try {
        await fetchImpl(endpoint, { method: 'DELETE', headers: { ...headers } });
      } catch { /* Closing a remote session is best-effort. */ }
    }
  };

  try {
    const initialized = await call('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Axiom', version: '1.0.0' }
    }, 1);
    const negotiatedVersion = initialized?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    headers['MCP-Protocol-Version'] = negotiatedVersion;
    await call('notifications/initialized', {});
    const result = await call('tools/list', {});
    return { tools: result?.tools || [], call, close };
  } catch (error) {
    // Initialization can allocate a remote session before discovery fails.
    // Release that session rather than leaking it on the server.
    await close();
    throw error;
  }
}

export async function connectMcpSse(endpoint, { fetchImpl = fetch, timeoutMs = 12000 } = {}) {
  if (typeof EventSource === 'undefined') throw new Error('EventSource is not supported in this browser.');
  const source = new EventSource(endpoint);
  const pending = new Map();
  let messageEndpoint = '';
  let nextId = 10;
  let protocolVersion = DEFAULT_PROTOCOL_VERSION;
  let closed = false;
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
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message || 'MCP request failed'));
      else waiter.resolve(message.result);
    } catch { /* Ignore non-JSON server events. */ }
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) {
      endpointReject(new Error('MCP SSE connection closed.'));
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('MCP SSE connection closed.'));
      }
      pending.clear();
    }
  };
  const post = async (message, waitForResult) => {
    if (closed) throw new Error('MCP connection is closed.');
    const target = await endpointReady;
    let responsePromise;
    if (waitForResult) {
      responsePromise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (pending.has(message.id)) {
            pending.delete(message.id);
            reject(new Error('MCP request timed out: ' + message.method));
          }
        }, timeoutMs);
        pending.set(message.id, { resolve, reject, timer });
      });
    }
    try {
      const response = await fetchImpl(target, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocolVersion },
        body: JSON.stringify(message)
      });
      if (!response.ok) throw new Error('MCP SSE message POST returned HTTP ' + response.status);
      if (!waitForResult) return null;
      const body = await response.text();
      if (body.trim()) {
        try {
          const payload = JSON.parse(body);
          if (payload.id !== undefined && pending.has(payload.id)) {
            const waiter = pending.get(payload.id);
            pending.delete(payload.id);
            clearTimeout(waiter.timer);
            if (payload.error) waiter.reject(new Error(payload.error.message || 'MCP request failed'));
            else waiter.resolve(payload.result);
          }
        } catch { /* The server may deliver the JSON-RPC reply over SSE instead. */ }
      }
      return await responsePromise;
    } catch (error) {
      const waiter = pending.get(message.id);
      if (waiter) {
        clearTimeout(waiter.timer);
        pending.delete(message.id);
        waiter.reject(error);
      }
      throw error;
    }
  };
  const call = async (method, params = {}) => {
    const id = nextId++;
    return await post({ jsonrpc: '2.0', id, method, params }, true);
  };
  try {
    const initialized = await call('initialize', {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'Axiom', version: '1.0.0' }
    });
    protocolVersion = initialized?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    await post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, false);
    const result = await call('tools/list', {});
    return {
      tools: result?.tools || [],
      call,
      close: () => {
        if (closed) return;
        closed = true;
        clearTimeout(endpointTimer);
        source.close();
        for (const waiter of pending.values()) {
          clearTimeout(waiter.timer);
          waiter.reject(new Error('MCP connection closed.'));
        }
        pending.clear();
      }
    };
  } catch (error) {
    closed = true;
    clearTimeout(endpointTimer);
    source.close();
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
    throw error;
  }
}
