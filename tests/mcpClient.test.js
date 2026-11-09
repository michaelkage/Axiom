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
