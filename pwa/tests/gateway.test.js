import test from 'node:test';
import assert from 'node:assert/strict';
import { createAxiomGateway, ensureGatewayToken, loadProviderCredentials } from '../gateway/server.mjs';
import { createCompanionCoordinator } from '../gateway/companion.js';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TOKEN = 'test-gateway-token-that-is-at-least-32-characters-long';
async function withServer(options, run) {
  const server = createAxiomGateway({ env: { AXIOM_GATEWAY_TOKEN: TOKEN, ...options.env }, fetchImpl: options.fetchImpl || fetch, logger: { error() {} }, ...(options.providerConfigPath ? { providerConfigPath: options.providerConfigPath } : {}) });
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


test('GitHub proxy is scoped to one configured repository and keeps the PAT server-side', async () => {
  let seen;
  await withServer({
    env: { GITHUB_TOKEN: 'github-server-secret', GITHUB_REPOSITORY: 'michaelkage/Axiom' },
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return new Response(JSON.stringify({ sha: 'blob' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }, async base => {
    const denied = await fetch(base + '/api/github/repos/other/repo/contents/README.md', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(denied.status, 403);
    const response = await fetch(base + '/api/github/repos/michaelkage/Axiom/contents/README.md', { headers: { authorization: 'token ' + TOKEN } });
    assert.equal(response.status, 200);
    assert.equal(seen.url, 'https://api.github.com/repos/michaelkage/Axiom/contents/README.md');
    assert.equal(seen.options.headers.authorization, 'Bearer github-server-secret');
  });
});

test('Supabase proxy injects only a configured publishable key', async () => {
  let seen;
  await withServer({
    env: { SUPABASE_URL: 'https://project.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_key' },
    fetchImpl: async (url, options) => {
      seen = { url: String(url), options };
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
  }, async base => {
    const response = await fetch(base + '/api/supabase/rest/v1/widgets?select=id', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(response.status, 200);
    assert.equal(seen.url, 'https://project.example.test/rest/v1/widgets?select=id');
    assert.equal(seen.options.headers.apikey, 'sb_publishable_test_key');
    assert.equal(seen.options.headers.authorization, 'Bearer sb_publishable_test_key');
  });
});

test('Supabase gateway rejects secret keys before proxying', async () => {
  await withServer({
    env: { SUPABASE_URL: 'https://project.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_do_not_use' },
    fetchImpl: async () => { throw new Error('must not call upstream'); }
  }, async base => {
    const response = await fetch(base + '/api/supabase/rest/v1/widgets', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /must not be a secret key/);
  });
});


test('gateway pairs a native ephemeral session token using the bootstrap credential', async () => {
  const session = 'native-session-token-that-is-at-least-32-characters-long';
  await withServer({
    fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }, async base => {
    const denied = await fetch(base + '/session/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: session, ttlSeconds: 3600 })
    });
    assert.equal(denied.status, 401);
    const paired = await fetch(base + '/session/register', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ token: session, ttlSeconds: 3600 })
    });
    assert.equal(paired.status, 201);
    const body = await paired.json();
    assert.equal(body.ok, true);
    assert.equal(body.expiresIn, 3600);
    const proxy = await fetch(base + '/api/ollama/api/tags', { headers: { authorization: 'Bearer ' + session } });
    assert.equal(proxy.status, 200);
  });
});

test('gateway rejects malformed native session registrations', async () => {
  await withServer({}, async base => {
    const response = await fetch(base + '/session/register', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'short', ttlSeconds: 3600 })
    });
    assert.equal(response.status, 400);
  });
});

test('diagnostics reports provider reachability without exposing credentials', async () => {
  const calls = [];
  await withServer({ env: { GITHUB_TOKEN: 'github-server-secret', GITHUB_REPOSITORY: 'michaelkage/Axiom', SUPABASE_URL: 'https://project.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_server_secret' },
    fetchImpl: async (url, options) => { calls.push({ url: String(url), headers: options.headers }); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); }
  }, async base => {
    assert.equal((await fetch(base + '/diagnostics')).status, 401);
    const response = await fetch(base + '/diagnostics', { headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.services.ollama.status, 'connected');
    assert.equal(data.services.github.authenticated, true);
    assert.equal(data.services.supabase.authenticated, true);
    assert.equal(JSON.stringify(data).includes('github-server-secret'), false);
    assert.equal(JSON.stringify(data).includes('sb_publishable_server_secret'), false);
    assert.equal(calls.length, 3);
    assert.ok(calls.some(call => call.url === 'https://api.github.com/repos/michaelkage/Axiom'));
    assert.ok(calls.some(call => call.url === 'https://project.example.test/rest/v1/'));
  });
});

test('diagnostics reports missing provider configuration and offline upstreams', async () => {
  await withServer({ fetchImpl: async () => { throw new Error('upstream unavailable'); } }, async base => {
    const response = await fetch(base + '/diagnostics', { headers: { authorization: 'Bearer ' + TOKEN } });
    const data = await response.json();
    assert.equal(data.services.github.status, 'missing');
    assert.equal(data.services.supabase.status, 'missing');
    assert.match(data.services.supabase.message, /missing/);
    assert.equal(data.services.ollama.status, 'offline');
    assert.deepEqual(data.services.mcp, []);
  });
});


test('diagnostics distinguishes rejected GitHub and Supabase credentials', async () => {
  await withServer({
    env: { GITHUB_TOKEN: 'rejected-github-token', GITHUB_REPOSITORY: 'michaelkage/Axiom', SUPABASE_URL: 'https://project.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_rejected' },
    fetchImpl: async url => new Response('{}', { status: String(url).includes('api.github.com') ? 401 : 403 })
  }, async base => {
    const response = await fetch(base + '/diagnostics', { headers: { authorization: 'Bearer ' + TOKEN } });
    const data = await response.json();
    assert.equal(data.services.github.status, 'error');
    assert.equal(data.services.github.authenticated, false);
    assert.match(data.services.github.message, /rejected/);
    assert.equal(data.services.supabase.status, 'error');
    assert.equal(data.services.supabase.httpStatus, 403);
    assert.match(data.services.supabase.message, /denied access/);
  });
});

test('diagnostics refuses a Supabase secret key without contacting Supabase', async () => {
  let upstreamCalls = 0;
  await withServer({
    env: { SUPABASE_URL: 'https://project.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_secret_forbidden' },
    fetchImpl: async () => { upstreamCalls += 1; return new Response('{}', { status: 200 }); }
  }, async base => {
    const response = await fetch(base + '/diagnostics', { headers: { authorization: 'Bearer ' + TOKEN } });
    const data = await response.json();
    assert.equal(data.services.supabase.status, 'error');
    assert.match(data.services.supabase.message, /must not be a secret key/);
    assert.equal(upstreamCalls, 1); // Ollama only
  });
});


test('gateway pairing token is generated once, persisted privately, and not printed again', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-gateway-'));
  const env = {};
  const firstLogs = [];
  const logger = { warn: value => firstLogs.push(String(value)) };
  try {
    const first = await ensureGatewayToken(env, logger, directory);
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(env.AXIOM_GATEWAY_TOKEN, first);
    assert.equal(firstLogs.filter(line => line === first).length, 1);
    const file = join(directory, 'gateway-token');
    assert.equal((await readFile(file, 'utf8')).trim(), first);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);

    const secondLogs = [];
    const second = await ensureGatewayToken({}, { warn: value => secondLogs.push(String(value)) }, directory);
    assert.equal(second, first);
    assert.equal(secondLogs.length, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Termux bootstrap can generate the pairing token without writing it to gateway logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-gateway-silent-'));
  const env = { AXIOM_GATEWAY_SILENT_TOKEN: '1' };
  const warnings = [];
  const infos = [];
  try {
    const token = await ensureGatewayToken(env, {
      warn: value => warnings.push(String(value)),
      info: value => infos.push(String(value))
    }, directory);
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.equal(env.AXIOM_GATEWAY_TOKEN, token);
    assert.equal(warnings.length, 0);
    assert.ok(infos.some(line => line.includes('stored with owner-only permissions')));
    assert.equal((await readFile(join(directory, 'gateway-token'), 'utf8')).trim(), token);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Ollama proxy streams pull requests and forwards the model reference', async () => {
  let seen;
  await withServer({ fetchImpl: async (url, options) => {
    seen = { url: String(url), options };
    return new Response('{"status":"pulling manifest"}' + String.fromCharCode(10) + '{"status":"success"}' + String.fromCharCode(10), {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' }
    });
  } }, async base => {
    const response = await fetch(base + '/api/ollama/api/pull', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'hf.co/example/model-GGUF:Q4_K_M', stream: true })
    });
    assert.equal(response.status, 200);
    assert.ok(seen.url.endsWith('/api/pull'));
    assert.deepEqual(JSON.parse(seen.options.body.toString()), { model: 'hf.co/example/model-GGUF:Q4_K_M', stream: true });
    assert.match(await response.text(), /"status":"success"/);
  });
});


test('provider configuration requires gateway authentication and never returns saved secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-provider-config-'));
  const path = join(directory, 'provider-credentials.json');
  const env = {};
  try {
    await withServer({ env, providerConfigPath: path }, async base => {
      const denied = await fetch(base + '/provider-config');
      assert.equal(denied.status, 401);
      const saved = await fetch(base + '/provider-config', {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({
          githubToken: 'github_pat_test_secret',
          githubRepository: 'michaelkage/Axiom',
          supabaseUrl: 'https://project.supabase.co',
          supabaseKey: 'sb_publishable_test_key'
        })
      });
      assert.equal(saved.status, 200);
      const payload = await saved.json();
      assert.equal(payload.github.configured, true);
      assert.equal(payload.supabase.configured, true);
      assert.equal(JSON.stringify(payload).includes('github_pat_test_secret'), false);
      assert.equal(JSON.stringify(payload).includes('sb_publishable_test_key'), false);
      const config = JSON.parse(await readFile(path, 'utf8'));
      assert.equal(config.githubToken, 'github_pat_test_secret');
      assert.equal(config.supabaseKey, 'sb_publishable_test_key');
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      const status = await fetch(base + '/provider-config', { headers: { authorization: 'Bearer ' + TOKEN } });
      const statusPayload = await status.json();
      assert.equal(statusPayload.github.repository, 'michaelkage/Axiom');
      assert.equal(statusPayload.supabase.url, 'https://project.supabase.co');
      assert.equal(JSON.stringify(statusPayload).includes('github_pat_test_secret'), false);
    });
    const restored = {};
    const status = await loadProviderCredentials(restored, directory);
    assert.deepEqual(status, { github: true, supabase: true });
    assert.equal(restored.GITHUB_TOKEN, 'github_pat_test_secret');
    assert.equal(restored.SUPABASE_PUBLISHABLE_KEY, 'sb_publishable_test_key');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('provider configuration rejects Supabase secret keys and non-HTTPS remote URLs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-provider-reject-'));
  try {
    await withServer({ providerConfigPath: join(directory, 'provider-credentials.json') }, async base => {
      const headers = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
      const secret = await fetch(base + '/provider-config', {
        method: 'PUT', headers,
        body: JSON.stringify({ supabaseUrl: 'https://project.supabase.co', supabaseKey: 'sb_secret_forbidden' })
      });
      assert.equal(secret.status, 400);
      const insecure = await fetch(base + '/provider-config', {
        method: 'PUT', headers,
        body: JSON.stringify({ supabaseUrl: 'http://remote.example.test', supabaseKey: 'sb_publishable_test_key' })
      });
      assert.equal(insecure.status, 400);
      const invalidRepo = await fetch(base + '/provider-config', {
        method: 'PUT', headers,
        body: JSON.stringify({ githubToken: 'github_pat_test_secret', githubRepository: 'not-a-repository' })
      });
      assert.equal(invalidRepo.status, 400);
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('companion pairing issues a restricted credential and supports explicit approval decisions', async () => {
  await withServer({ fetchImpl: async () => new Response('{}', { status: 200 }) }, async base => {
    const desktopHeaders = { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' };
    const inviteResponse = await fetch(base + '/companion/pairing', { method: 'POST', headers: desktopHeaders });
    assert.equal(inviteResponse.status, 201);
    const invite = await inviteResponse.json();
    assert.match(invite.code, /^\d{8}$/);
    assert.equal(invite.expiresIn, 90);

    const claimResponse = await fetch(base + '/companion/pairing/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: invite.code, deviceName: 'Android phone' })
    });
    assert.equal(claimResponse.status, 201);
    const paired = await claimResponse.json();
    assert.equal(paired.deviceName, 'Android phone');
    assert.equal(paired.expiresIn, 43200);

    const blockedProxy = await fetch(base + '/api/ollama/api/tags', { headers: { authorization: 'Bearer ' + paired.token } });
    assert.equal(blockedProxy.status, 403);
    const blockedQueue = await fetch(base + '/companion/approvals', { headers: { authorization: 'Bearer ' + paired.token } });
    assert.equal(blockedQueue.status, 403);

    const requestResponse = await fetch(base + '/companion/approvals', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + paired.token, 'content-type': 'application/json' },
      body: JSON.stringify({ capability: 'shell.execute', summary: 'Run the test suite', command: 'npm test' })
    });
    assert.equal(requestResponse.status, 201);
    const approval = await requestResponse.json();
    assert.equal(approval.status, 'pending');

    const queueResponse = await fetch(base + '/companion/approvals', { headers: { authorization: 'Bearer ' + TOKEN } });
    const queue = await queueResponse.json();
    assert.equal(queue.approvals.length, 1);
    assert.equal(queue.approvals[0].id, approval.id);

    const decisionResponse = await fetch(base + '/companion/approvals/' + approval.id + '/decision', {
      method: 'POST', headers: desktopHeaders, body: JSON.stringify({ decision: 'approved' })
    });
    assert.equal(decisionResponse.status, 200);
    assert.equal((await decisionResponse.json()).status, 'approved');

    const statusResponse = await fetch(base + '/companion/approvals/' + approval.id, { headers: { authorization: 'Bearer ' + paired.token } });
    assert.equal((await statusResponse.json()).status, 'approved');

    const revoked = await fetch(base + '/companion/pairs/' + paired.pairId, { method: 'DELETE', headers: { authorization: 'Bearer ' + TOKEN } });
    assert.equal(revoked.status, 200);
    assert.equal((await revoked.json()).revoked, true);
    const afterRevoke = await fetch(base + '/companion/approvals/' + approval.id, { headers: { authorization: 'Bearer ' + paired.token } });
    assert.equal(afterRevoke.status, 401);
  });
});


test('companion coordinator bounds paired sessions and reclaims expired slots', () => {
  let timestamp = 1_000;
  const companion = createCompanionCoordinator({ now: () => timestamp });
  const claim = index => {
    const invite = companion.createInvite('desktop-gateway-token-that-is-at-least-32-characters');
    return companion.claimInvite({ code: invite.code, deviceName: 'Device ' + index });
  };
  for (let index = 0; index < 100; index += 1) claim(index);
  assert.throws(() => claim(100), error => error.status === 429 && /Too many paired devices/.test(error.message));
  timestamp += 12 * 60 * 60 * 1000;
  assert.equal(companion.isCompanionSession('not-a-session'), false);
  assert.doesNotThrow(() => claim(101));
});


test('companion pairing claim enforces the per-source rolling rate limit', async () => {
  await withServer({}, async base => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const response = await fetch(base + '/companion/pairing/claim', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '00000000', deviceName: 'Untrusted device' })
      });
      assert.equal(response.status, 401);
    }
    const limited = await fetch(base + '/companion/pairing/claim', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '00000000', deviceName: 'Untrusted device' })
    });
    assert.equal(limited.status, 429);
    assert.match((await limited.json()).error, /Too many pairing attempts/);
  });
});
