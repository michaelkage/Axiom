import test from 'node:test';
import assert from 'node:assert/strict';
import { createAxiomGateway } from '../gateway/server.mjs';

const TOKEN = 'test-gateway-token-that-is-at-least-32-characters-long';
async function withServer(options, run) {
  const server = createAxiomGateway({ env: { AXIOM_GATEWAY_TOKEN: TOKEN, ...options.env }, fetchImpl: options.fetchImpl || fetch, logger: { error() {} } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try { await run('http://127.0.0.1:' + address.port); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

test('gateway requires a strong token at startup', () => {
  assert.throws(() => createAxiomGateway({ env: { AXIOM_GATEWAY_TOKEN: 'short' } }), /at least 32 characters/);
});

test('health is public but protected routes reject missing credentials', async () => {
  await withServer({}, async base => {
    const health = await fetch(base + '/health');
    assert.equal(health.status, 200);
    const response = await fetch(base + '/api/ollama/api/tags');
    assert.equal(response.status, 401);
  });
});

test('Ollama proxy only permits known API paths and injects no browser credentials', async () => {
  let seen;
  await withServer({ fetchImpl: async (url, options) => {
    seen = { url: String(url), options };
    return new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
  } }, async base => {
    const blocked = await fetch(base + '/api/ollama/api/delete', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(blocked.status, 404);
    const response = await fetch(base + '/api/ollama/api/tags', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(response.status, 200);
    assert.match(seen.url, /^http:\/\/127\.0\.0\.1:11434\/api\/tags$/);
    assert.equal(seen.options.headers.authorization, undefined);
  });
});

test('MCP proxy only reaches explicitly configured server IDs and injects server-side credentials', async () => {
  let seen;
  await withServer({
    env: { MCP_SERVERS_JSON: JSON.stringify({ trusted: { url: 'https://mcp.example.test/rpc', token: 'server-side-secret' } }) },
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }), { status: 200, headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-1' } });
    }
  }, async base => {
    const missing = await fetch(base + '/api/mcp/arbitrary', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(missing.status, 404);
    const response = await fetch(base + '/api/mcp/trusted', { method: 'POST', headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.equal(seen.url, 'https://mcp.example.test/rpc');
    assert.equal(seen.options.headers.authorization, 'Bearer server-side-secret');
    assert.equal(response.headers.get('mcp-session-id'), 'session-1');
  });
});

test('gateway rejects untrusted browser origins', async () => {
  await withServer({}, async base => {
    const response = await fetch(base + '/api/ollama/api/tags', { headers: { origin: 'https://attacker.example', authorization: 'Bearer ' + TOKEN } });
    assert.equal(response.status, 403);
  });
});
