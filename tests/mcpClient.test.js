import test from 'node:test';
import assert from 'node:assert/strict';
import { connectMcpHttp } from '../src/lib/mcpClient.js';

test('initializes Streamable HTTP MCP session and discovers tools', async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    if (init.method === 'DELETE') return new Response(null, { status: 200 });
    const request = JSON.parse(init.body);
    requests.push({ request, headers: { ...init.headers } });
    if (request.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-03-26' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'test-session' }
      });
    }
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (request.method === 'tools/list') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'ping', inputSchema: { type: 'object', properties: {} } }] } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (request.method === 'tools/call') {
      return new Response('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: 'pong' }] } }) + '\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }
    throw new Error('Unexpected MCP method: ' + request.method);
  };

  const connection = await connectMcpHttp('https://mcp.example.test/mcp', { fetchImpl, token: 'test-token' });
  assert.equal(connection.tools[0].name, 'ping');
  assert.equal(requests[0].headers.Authorization, 'Bearer test-token');
  assert.equal(requests[2].headers['Mcp-Session-Id'], 'test-session');
  assert.equal(requests[2].headers['MCP-Protocol-Version'], '2025-03-26');
  const result = await connection.call('tools/call', { name: 'ping', arguments: {} });
  assert.equal(result.content[0].text, 'pong');
  assert.notEqual(requests[2].request.id, requests[3].request.id);
  await connection.close();
});


test('initializes legacy SSE transport, resolves relative message endpoint, and negotiates protocol version', async () => {
  const previousEventSource = globalThis.EventSource;
  const requests = [];
  let eventSource;
  class MockEventSource {
    static CLOSED = 2;
    static CONNECTING = 0;
    static OPEN = 1;
    constructor(url) {
      this.url = url;
      this.readyState = MockEventSource.OPEN;
      this.listeners = new Map();
      this.closed = false;
      eventSource = this;
      queueMicrotask(() => this.emit('endpoint', { data: '../messages' }));
    }
    addEventListener(name, callback) {
      const callbacks = this.listeners.get(name) || [];
      callbacks.push(callback);
      this.listeners.set(name, callbacks);
    }
    emit(name, event) {
      for (const callback of this.listeners.get(name) || []) callback(event);
    }
    close() {
      this.closed = true;
      this.readyState = MockEventSource.CLOSED;
    }
  }
  globalThis.EventSource = MockEventSource;
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ url, request, headers: { ...init.headers } });
    if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
    const result = request.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: {} }
      : { tools: [{ name: 'sse_ping', inputSchema: { type: 'object', properties: {} } }] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    const connection = await connectMcpSse('https://mcp.example.test/sse', { fetchImpl, timeoutMs: 100 });
    assert.equal(connection.tools[0].name, 'sse_ping');
    assert.equal(requests[0].url, 'https://mcp.example.test/messages');
    assert.equal(requests[1].headers['MCP-Protocol-Version'], '2025-06-18');
    assert.equal(requests[2].headers['MCP-Protocol-Version'], '2025-06-18');
    assert.equal(requests[2].request.method, 'tools/list');
    await connection.close();
    assert.equal(eventSource.closed, true);
  } finally {
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  }
});

test('legacy SSE transport rejects cleanly when the server closes before publishing its message endpoint', async () => {
  const previousEventSource = globalThis.EventSource;
  class ClosingEventSource {
    static CLOSED = 2;
    constructor() {
      this.readyState = 0;
      this.listeners = new Map();
      queueMicrotask(() => {
        this.readyState = ClosingEventSource.CLOSED;
        this.onerror?.();
      });
    }
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    }
    close() {}
  }
  globalThis.EventSource = ClosingEventSource;
  try {
    await assert.rejects(
      connectMcpSse('https://mcp.example.test/sse', { fetchImpl: async () => { throw new Error('Should not POST'); }, timeoutMs: 100 }),
      /MCP SSE connection closed/
    );
  } finally {
    if (previousEventSource === undefined) delete globalThis.EventSource;
    else globalThis.EventSource = previousEventSource;
  }
});
