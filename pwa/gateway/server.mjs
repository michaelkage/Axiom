import http from 'node:http';
import { resolve, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { mkdir, readFile, writeFile, chmod, rename, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { createCompanionCoordinator } from './companion.js';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const OLLAMA_PATHS = new Set(['/api/tags', '/api/chat', '/api/generate', '/api/show', '/api/ps', '/api/pull']);
const MCP_HEADERS = ['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id'];

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseOrigins(value = '') {
  return new Set(value.split(',').map(item => item.trim()).filter(Boolean));
}

function parseMcpServers(value = '{}') {
  let parsed;
  try { parsed = JSON.parse(value); }
  catch { throw new Error('MCP_SERVERS_JSON must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP_SERVERS_JSON must be an object.');
  for (const [id, item] of Object.entries(parsed)) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || !item || typeof item.url !== 'string') throw new Error('Invalid MCP server configuration for ' + id);
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('MCP server URLs must be HTTP(S) URLs without embedded credentials.');
  }
  return parsed;
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('Request body exceeds 2 MiB.'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function applyCors(req, res, origins) {
  const origin = req.headers.origin;
  if (origin && origins.has(origin)) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('vary', 'Origin');
    res.setHeader('access-control-allow-headers', 'authorization, apikey, content-type, accept, prefer, range, range-unit, accept-profile, content-profile, x-client-info, mcp-session-id, mcp-protocol-version, last-event-id');
    res.setHeader('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
    res.setHeader('access-control-max-age', '600');
  }
  return !origin || origins.has(origin);
}

function upstreamHeaders(req, extra = {}) {
  const headers = { accept: req.headers.accept || 'application/json', ...extra };
  for (const name of MCP_HEADERS) if (req.headers[name]) headers[name] = req.headers[name];
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  return headers;
}

export function createAxiomGateway({
  env = process.env,
  fetchImpl = fetch,
  logger = console,
  now = Date.now,
  providerConfigPath = join(homedir(), '.config', 'axiom', 'provider-credentials.json')
} = {}) {
  const token = env.AXIOM_GATEWAY_TOKEN;
  if (!token || token.length < 32) throw new Error('AXIOM_GATEWAY_TOKEN must be set to a random value of at least 32 characters.');
  const ollamaBase = new URL(env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434');
  if (!['http:', 'https:'].includes(ollamaBase.protocol) || ollamaBase.username || ollamaBase.password) throw new Error('OLLAMA_BASE_URL must be an HTTP(S) URL without embedded credentials.');
  const origins = parseOrigins(env.AXIOM_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,https://localhost,capacitor://localhost');
  const mcpServers = parseMcpServers(env.MCP_SERVERS_JSON || '{}');
  const sessionTokens = new Map();
  const companionTokens = new Set();
  const companion = createCompanionCoordinator({ now });
  const pairingAttempts = new Map();

  const server = http.createServer(async (req, res) => {
    if (!applyCors(req, res, origins)) return sendJson(res, 403, { error: 'Origin not allowed.' });
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/health' && req.method === 'GET') return sendJson(res, 200, { ok: true, service: 'axiom-gateway' });

    const auth = req.headers.authorization || '';
    const presentedToken = auth.startsWith('Bearer ') ? auth.slice(7) : auth.startsWith('token ') ? auth.slice(6) : (req.headers.apikey || '');

    if (url.pathname === '/companion/pairing/claim' && req.method === 'POST') {
      const address = req.socket.remoteAddress || 'unknown';
      const timestamp = now();
      const attempts = (pairingAttempts.get(address) || []).filter(value => timestamp - value < 60_000);
      if (attempts.length >= 10) return sendJson(res, 429, { error: 'Too many pairing attempts. Wait one minute and try again.' });
      attempts.push(timestamp);
      pairingAttempts.set(address, attempts);
      const body = await readBody(req).catch(error => { sendJson(res, error.status || 400, { error: error.message }); return null; });
      if (body === null) return;
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
      try {
        const paired = companion.claimInvite(input);
        sessionTokens.set(paired.token, now() + paired.expiresIn * 1000);
        companionTokens.add(paired.token);
        return sendJson(res, 201, { ok: true, token: paired.token, pairId: paired.pairId, deviceName: paired.deviceName, expiresIn: paired.expiresIn });
      } catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    }

    if (url.pathname === '/session/register' && req.method === 'POST') {
      if (!safeEqual(presentedToken, token)) return sendJson(res, 401, { error: 'Gateway pairing token rejected.' });
      const body = await readBody(req).catch(error => { sendJson(res, error.status || 400, { error: error.message }); return null; });
      if (body === null) return;
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
      const sessionToken = typeof input.token === 'string' ? input.token : '';
      const ttlSeconds = Number(input.ttlSeconds || 43200);
      if (sessionToken.length < 32 || sessionToken.length > 256 || !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 43200) return sendJson(res, 400, { error: 'Session token or lifetime is invalid.' });
      sessionTokens.set(sessionToken, now() + ttlSeconds * 1000);
      return sendJson(res, 201, { ok: true, expiresIn: ttlSeconds });
    }

    let authenticated = safeEqual(presentedToken, token);
    if (!authenticated && presentedToken.length >= 32) {
      const expiresAt = sessionTokens.get(presentedToken);
      if (expiresAt && expiresAt > now()) authenticated = true;
      else if (expiresAt) sessionTokens.delete(presentedToken);
    }
    if (!authenticated) return sendJson(res, 401, { error: 'Unauthorized.' });

    const isCompanionSession = companionTokens.has(presentedToken);
    if (url.pathname === '/companion/pairing' && req.method === 'POST') {
      if (isCompanionSession) return sendJson(res, 403, { error: 'Only the paired desktop session can create pairing codes.' });
      try { return sendJson(res, 201, companion.createInvite(presentedToken)); }
      catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    }
    if (url.pathname === '/companion/approvals' && req.method === 'POST') {
      const body = await readBody(req).catch(error => { sendJson(res, error.status || 400, { error: error.message }); return null; });
      if (body === null) return;
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
      try { return sendJson(res, 201, companion.createApproval(presentedToken, input)); }
      catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    }
    if (url.pathname === '/companion/approvals' && req.method === 'GET') {
      if (isCompanionSession) return sendJson(res, 403, { error: 'Companion devices cannot read the desktop approval queue.' });
      return sendJson(res, 200, { approvals: companion.listApprovals(presentedToken) });
    }
    const approvalDecision = url.pathname.match(/^\\/companion\\/approvals\\/([a-f0-9-]{36})\\/decision$/);
    if (approvalDecision && req.method === 'POST') {
      if (isCompanionSession) return sendJson(res, 403, { error: 'Only the desktop session can decide approvals.' });
      const body = await readBody(req).catch(error => { sendJson(res, error.status || 400, { error: error.message }); return null; });
      if (body === null) return;
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
      try { return sendJson(res, 200, companion.decideApproval(presentedToken, approvalDecision[1], input.decision)); }
      catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    }
    const approvalStatus = url.pathname.match(/^\\/companion\\/approvals\\/([a-f0-9-]{36})$/);
    if (approvalStatus && req.method === 'GET') {
      try { return sendJson(res, 200, companion.getApproval(presentedToken, approvalStatus[1])); }
      catch (error) { return sendJson(res, error.status || 400, { error: error.message }); }
    }
    const pairRevocation = url.pathname.match(/^\\/companion\\/pairs\\/([a-f0-9-]{36})$/);
    if (pairRevocation && req.method === 'DELETE') {
      if (isCompanionSession) return sendJson(res, 403, { error: 'Only the desktop session can revoke paired devices.' });
      const removed = companion.revokePair(presentedToken, pairRevocation[1]);
      for (const pairedToken of removed) { companionTokens.delete(pairedToken); sessionTokens.delete(pairedToken); }
      return sendJson(res, 200, { ok: true, revoked: removed.length > 0 });
    }
    if (isCompanionSession) return sendJson(res, 403, { error: 'Companion credentials are restricted to pairing and approval endpoints.' });

    const requestController = new AbortController();
    req.on('aborted', () => requestController.abort(new Error('Client request aborted.')));
    res.on('close', () => { if (!res.writableEnded) requestController.abort(new Error('Client disconnected.')); });
    const upstreamSignal = timeoutMs => AbortSignal.any([requestController.signal, AbortSignal.timeout(timeoutMs)]);


    if (url.pathname === '/provider-config' && req.method === 'GET') {
      return sendJson(res, 200, {
        github: { configured: Boolean(env.GITHUB_TOKEN), repository: String(env.GITHUB_REPOSITORY || '') },
        supabase: { configured: Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY), url: String(env.SUPABASE_URL || '') }
      });
    }

    if (url.pathname === '/provider-config' && req.method === 'PUT') {
      const body = await readBody(req).catch(error => { sendJson(res, error.status || 400, { error: error.message }); return null; });
      if (body === null) return;
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
      if (!input || typeof input !== 'object' || Array.isArray(input)) return sendJson(res, 400, { error: 'Provider configuration must be an object.' });
      const allowed = new Set(['githubToken', 'githubRepository', 'supabaseUrl', 'supabaseKey', 'clearGithub', 'clearSupabase']);
      if (Object.keys(input).some(key => !allowed.has(key))) return sendJson(res, 400, { error: 'Unknown provider configuration field.' });

      const next = {
        githubToken: String(env.GITHUB_TOKEN || ''),
        githubRepository: String(env.GITHUB_REPOSITORY || ''),
        supabaseUrl: String(env.SUPABASE_URL || ''),
        supabaseKey: String(env.SUPABASE_PUBLISHABLE_KEY || '')
      };
      if (input.clearGithub === true) { next.githubToken = ''; next.githubRepository = ''; }
      if (input.clearSupabase === true) { next.supabaseUrl = ''; next.supabaseKey = ''; }
      for (const field of ['githubToken', 'githubRepository', 'supabaseUrl', 'supabaseKey']) {
        if (Object.hasOwn(input, field)) {
          if (typeof input[field] !== 'string') return sendJson(res, 400, { error: field + ' must be a string.' });
          next[field] = input[field].trim();
        }
      }
      if (next.githubToken && (!next.githubRepository || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(next.githubRepository))) {
        return sendJson(res, 400, { error: 'A valid GitHub repository in owner/repo format is required with the PAT.' });
      }
      if (next.githubToken.length > 512) return sendJson(res, 400, { error: 'GitHub token is too long.' });
      if (Boolean(next.supabaseUrl) !== Boolean(next.supabaseKey)) return sendJson(res, 400, { error: 'Supabase project URL and publishable key must be provided together.' });
      if (next.supabaseKey.startsWith('sb_secret_')) return sendJson(res, 400, { error: 'Use a Supabase publishable key or legacy anon key, never a secret/service_role key.' });
      if (next.supabaseKey.length > 4096) return sendJson(res, 400, { error: 'Supabase key is too long.' });
      if (next.supabaseKey.startsWith('eyJ')) {
        try {
          const claims = JSON.parse(Buffer.from(next.supabaseKey.split('.')[1], 'base64url').toString('utf8'));
          if (claims.role !== 'anon') return sendJson(res, 400, { error: 'Legacy Supabase JWT must use the anon role, never service_role.' });
        } catch {
          return sendJson(res, 400, { error: 'Supabase publishable key is not a valid publishable key or anon JWT.' });
        }
      }
      if (next.supabaseUrl) {
        let parsed;
        try { parsed = new URL(next.supabaseUrl); } catch { return sendJson(res, 400, { error: 'Supabase project URL is invalid.' }); }
        const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
        if ((!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol !== 'https:' && !localHost)) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname !== '/' && parsed.pathname !== '')) {
          return sendJson(res, 400, { error: 'Supabase URL must be an HTTPS project origin (HTTP is allowed only for localhost).' });
        }
        next.supabaseUrl = parsed.origin;
      }

      await mkdir(dirname(providerConfigPath), { recursive: true, mode: 0o700 });
      await chmod(dirname(providerConfigPath), 0o700);
      const temporaryPath = providerConfigPath + '.' + randomBytes(8).toString('hex') + '.tmp';
      try {
        await writeFile(temporaryPath, JSON.stringify(next) + String.fromCharCode(10), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        await chmod(temporaryPath, 0o600);
        await rename(temporaryPath, providerConfigPath);
        await chmod(providerConfigPath, 0o600);
      } catch {
        await rm(temporaryPath, { force: true }).catch(() => {});
        return sendJson(res, 500, { error: 'Could not securely persist provider credentials on the gateway host.' });
      }
      env.GITHUB_TOKEN = next.githubToken;
      env.GITHUB_REPOSITORY = next.githubRepository;
      env.SUPABASE_URL = next.supabaseUrl;
      env.SUPABASE_PUBLISHABLE_KEY = next.supabaseKey;
      return sendJson(res, 200, {
        ok: true,
        github: { configured: Boolean(next.githubToken), repository: next.githubRepository },
        supabase: { configured: Boolean(next.supabaseUrl && next.supabaseKey), url: next.supabaseUrl }
      });
    }

    if (url.pathname === '/diagnostics' && req.method === 'GET') {
      const checkedAt = new Date(now()).toISOString();
      const check = async (name, configured, target, headers = {}) => {
        if (!configured) return { configured: false, reachable: false, authenticated: false, status: 'missing', message: name + ' is not configured on the gateway.' };
        try {
          const upstream = await fetchImpl(target, { method: 'GET', headers, signal: upstreamSignal(8000) });
          const accepted = upstream.status >= 200 && upstream.status < 300;
          const message = accepted ? name + ' is reachable and accepted the configured credential.'
            : upstream.status === 401 ? name + ' rejected the configured credential.'
            : upstream.status === 403 ? name + ' denied access. Check token permissions or project access.'
            : upstream.status === 404 ? name + ' could not find the configured resource. Check its URL or repository.'
            : name + ' returned HTTP ' + upstream.status + '.';
          await upstream.body?.cancel().catch(() => {});
          return { configured: true, reachable: true, authenticated: accepted, status: accepted ? 'connected' : 'error', httpStatus: upstream.status, message };
        } catch {
          return { configured: true, reachable: false, authenticated: false, status: 'offline', message: name + ' could not be reached. Check the gateway host network and upstream URL.' };
        }
      };
      const githubRepo = String(env.GITHUB_REPOSITORY || '');
      const githubValid = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(githubRepo);
      const supabaseUrl = String(env.SUPABASE_URL || '');
      const supabaseKey = String(env.SUPABASE_PUBLISHABLE_KEY || '');
      let supabaseTarget = null;
      let supabaseConfigError = '';
      try {
        if (!supabaseUrl || !supabaseKey) throw new Error('Supabase URL or publishable key is missing.');
        if (supabaseKey.startsWith('sb_secret_')) throw new Error('SUPABASE_PUBLISHABLE_KEY must not be a secret key.');
        if (supabaseKey.startsWith('eyJ')) {
          const claims = JSON.parse(Buffer.from(supabaseKey.split('.')[1], 'base64url').toString('utf8'));
          if (claims.role !== 'anon') throw new Error('SUPABASE_PUBLISHABLE_KEY must use the anon role, never service_role.');
        }
        const parsed = new URL(supabaseUrl);
        if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('SUPABASE_URL must be a valid HTTP(S) URL without embedded credentials.');
        supabaseTarget = new URL('/rest/v1/', parsed);
      } catch (error) { supabaseConfigError = error.message; }
      const [ollama, github, supabase] = await Promise.all([
        check('Ollama', true, new URL('/api/tags', ollamaBase)),
        check('GitHub', Boolean(env.GITHUB_TOKEN && githubValid),
          githubValid ? new URL('/repos/' + githubRepo, 'https://api.github.com') : new URL('/user', 'https://api.github.com'),
          env.GITHUB_TOKEN ? { authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' } : {}),
        supabaseConfigError
          ? Promise.resolve({ configured: Boolean(supabaseUrl || supabaseKey), reachable: false, authenticated: false, status: supabaseUrl || supabaseKey ? 'error' : 'missing', message: supabaseConfigError })
          : check('Supabase', true, supabaseTarget, { apikey: supabaseKey, authorization: 'Bearer ' + supabaseKey, accept: 'application/json' })
      ]);
      const mcp = Object.keys(mcpServers).map(id => ({ id, configured: true, status: 'configured', message: 'MCP endpoint is configured. Run discovery from the MCP tab to verify protocol access.' }));
      return sendJson(res, 200, { ok: true, checkedAt, services: { ollama, github: { ...github, repository: githubRepo || null }, supabase, mcp } });
    }

    if (url.pathname.startsWith('/api/ollama/')) {
      const upstreamPath = url.pathname.slice('/api/ollama'.length);
      if (!OLLAMA_PATHS.has(upstreamPath) || !['GET', 'POST'].includes(req.method)) return sendJson(res, 404, { error: 'Ollama route not allowed.' });
      const body = req.method === 'GET' ? undefined : await readBody(req).catch(error => {
        sendJson(res, error.status || 400, { error: error.message }); return null;
      });
      if (body === null) return;
      const target = new URL(upstreamPath + url.search, ollamaBase);
      try {
        const upstream = await fetchImpl(target, {
          method: req.method,
          headers: upstreamHeaders(req),
          body,
          signal: upstreamSignal(120000)
        });
        res.writeHead(upstream.status, {
          'content-type': upstream.headers.get('content-type') || 'application/octet-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        return res.end();
      } catch (error) {
        logger.error?.('[axiom-gateway] Ollama upstream failed:', error.message);
        return sendJson(res, 502, { error: 'Ollama upstream unavailable.' });
      }
    }


    const githubMatch = url.pathname.match(/^\/api\/github\/repos\/([^/]+)\/([^/]+)\/contents\/(.+)$/);
    if (githubMatch) {
      const configuredRepo = env.GITHUB_REPOSITORY || '';
      const requestedRepo = githubMatch[1] + '/' + githubMatch[2];
      if (!env.GITHUB_TOKEN || !configuredRepo || requestedRepo.toLowerCase() !== configuredRepo.toLowerCase()) {
        return sendJson(res, 403, { error: 'GitHub repository is not configured for this gateway.' });
      }
      if (!['GET', 'PUT'].includes(req.method)) return sendJson(res, 405, { error: 'GitHub method not allowed.' });
      const body = req.method === 'GET' ? undefined : await readBody(req).catch(error => {
        sendJson(res, error.status || 400, { error: error.message }); return null;
      });
      if (body === null) return;
      const contentPath = decodeURIComponent(githubMatch[3]);
      if (contentPath.split('/').some(segment => segment === '.' || segment === '..') || contentPath.includes('\\\\')) {
        return sendJson(res, 400, { error: 'Invalid GitHub content path.' });
      }
      const target = new URL('/repos/' + requestedRepo + '/contents/' + contentPath + url.search, 'https://api.github.com');
      try {
        const upstream = await fetchImpl(target, {
          method: req.method,
          headers: { ...upstreamHeaders(req), authorization: 'Bearer ' + env.GITHUB_TOKEN, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
          body,
          signal: upstreamSignal(60000)
        });
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' });
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) { if (res.destroyed) break; res.write(chunk); }
        return res.end();
      } catch (error) {
        logger.error?.('[axiom-gateway] GitHub upstream failed:', error.message);
        return sendJson(res, 502, { error: 'GitHub upstream unavailable.' });
      }
    }

    const supabasePrefix = '/api/supabase/rest/v1/';
    if (url.pathname.startsWith(supabasePrefix)) {
      const key = env.SUPABASE_PUBLISHABLE_KEY || '';
      if (!env.SUPABASE_URL || !key) return sendJson(res, 503, { error: 'Supabase publishable-key upstream is not configured.' });
      if (key.startsWith('sb_secret_')) return sendJson(res, 500, { error: 'SUPABASE_PUBLISHABLE_KEY must not be a secret key.' });
      if (key.startsWith('eyJ')) {
        try {
          const claims = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString('utf8'));
          if (claims.role !== 'anon') return sendJson(res, 500, { error: 'SUPABASE_PUBLISHABLE_KEY must be an anon-role JWT, never service_role.' });
        } catch {
          return sendJson(res, 500, { error: 'SUPABASE_PUBLISHABLE_KEY is not a valid publishable key.' });
        }
      }
      if (!['GET', 'POST', 'PATCH', 'DELETE', 'HEAD'].includes(req.method)) return sendJson(res, 405, { error: 'Supabase method not allowed.' });
      const supabaseBase = new URL(env.SUPABASE_URL);
      if (!['http:', 'https:'].includes(supabaseBase.protocol) || supabaseBase.username || supabaseBase.password) {
        return sendJson(res, 500, { error: 'Invalid SUPABASE_URL gateway configuration.' });
      }
      const body = ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : await readBody(req).catch(error => {
        sendJson(res, error.status || 400, { error: error.message }); return null;
      });
      if (body === null) return;
      const suffix = url.pathname.slice('/api/supabase'.length);
      const target = new URL(suffix + url.search, supabaseBase);
      const headers = upstreamHeaders(req, { apikey: key, authorization: 'Bearer ' + key });
      try {
        const upstream = await fetchImpl(target, { method: req.method, headers, body, signal: upstreamSignal(60000) });
        const responseHeaders = { 'cache-control': 'no-store' };
        for (const name of ['content-type', 'content-range', 'content-location', 'preference-applied']) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders[name] = value;
        }
        res.writeHead(upstream.status, responseHeaders);
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) { if (res.destroyed) break; res.write(chunk); }
        return res.end();
      } catch (error) {
        logger.error?.('[axiom-gateway] Supabase upstream failed:', error.message);
        return sendJson(res, 502, { error: 'Supabase upstream unavailable.' });
      }
    }

    const mcpMatch = url.pathname.match(/^\/api\/mcp\/([a-zA-Z0-9_-]{1,64})$/);
    if (mcpMatch) {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) return sendJson(res, 405, { error: 'Method not allowed.' });
      const config = mcpServers[mcpMatch[1]];
      if (!config) return sendJson(res, 404, { error: 'MCP server is not configured in the gateway.' });
      const body = ['GET', 'DELETE'].includes(req.method) ? undefined : await readBody(req).catch(error => {
        sendJson(res, error.status || 400, { error: error.message }); return null;
      });
      if (body === null) return;
      const headers = upstreamHeaders(req, config.token ? { authorization: 'Bearer ' + config.token } : {});
      try {
        const upstream = await fetchImpl(config.url, { method: req.method, headers, body, signal: AbortSignal.timeout(120000) });
        const responseHeaders = {
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        };
        for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version']) {
          const value = upstream.headers.get(name);
          if (value) responseHeaders[name] = value;
        }
        res.writeHead(upstream.status, responseHeaders);
        if (!upstream.body) return res.end();
        for await (const chunk of upstream.body) {
          if (res.destroyed) break;
          res.write(chunk);
        }
        return res.end();
      } catch (error) {
        logger.error?.('[axiom-gateway] MCP upstream failed:', error.message);
        return sendJson(res, 502, { error: 'MCP upstream unavailable.' });
      }
    }

    return sendJson(res, 404, { error: 'Route not found.' });
  });

  return server;
}

export async function loadProviderCredentials(env = process.env, directory = join(homedir(), '.config', 'axiom')) {
  const path = join(directory, 'provider-credentials.json');
  try {
    const saved = JSON.parse(await readFile(path, 'utf8'));
    if (!env.GITHUB_TOKEN && typeof saved.githubToken === 'string') env.GITHUB_TOKEN = saved.githubToken;
    if (!env.GITHUB_REPOSITORY && typeof saved.githubRepository === 'string') env.GITHUB_REPOSITORY = saved.githubRepository;
    if (!env.SUPABASE_URL && typeof saved.supabaseUrl === 'string') env.SUPABASE_URL = saved.supabaseUrl;
    if (!env.SUPABASE_PUBLISHABLE_KEY && typeof saved.supabaseKey === 'string') env.SUPABASE_PUBLISHABLE_KEY = saved.supabaseKey;
    await chmod(path, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not load saved provider credentials: ' + error.message);
  }
  return { github: Boolean(env.GITHUB_TOKEN), supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_PUBLISHABLE_KEY) };
}

export async function ensureGatewayToken(env = process.env, logger = console, directory = join(homedir(), '.config', 'axiom')) {
  if (env.AXIOM_GATEWAY_TOKEN && env.AXIOM_GATEWAY_TOKEN.length >= 32) return env.AXIOM_GATEWAY_TOKEN;
  const tokenFile = join(directory, 'gateway-token');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  try {
    const existing = (await readFile(tokenFile, 'utf8')).trim();
    await chmod(tokenFile, 0o600);
    if (existing.length >= 64) {
      env.AXIOM_GATEWAY_TOKEN = existing;
      return existing;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const generated = randomBytes(32).toString('hex');
  try {
    await writeFile(tokenFile, generated + String.fromCharCode(10), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    env.AXIOM_GATEWAY_TOKEN = generated;
    if (env.AXIOM_GATEWAY_SILENT_TOKEN !== '1') {
      logger.warn?.('[axiom-gateway] FIRST RUN: copy this pairing token now. It will not be displayed again:');
      logger.warn?.(generated);
      logger.warn?.('[axiom-gateway] Token saved with owner-only permissions at ' + tokenFile);
    } else {
      logger.info?.('[axiom-gateway] Pairing credential generated and stored with owner-only permissions.');
    }
    return generated;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = (await readFile(tokenFile, 'utf8')).trim();
    if (existing.length < 64) throw new Error('Stored gateway token is invalid.');
    env.AXIOM_GATEWAY_TOKEN = existing;
    return existing;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await ensureGatewayToken();
  await loadProviderCredentials();
  const server = createAxiomGateway();
  const host = process.env.AXIOM_GATEWAY_HOST || '127.0.0.1';
  const port = Number(process.env.AXIOM_GATEWAY_PORT || 8787);
  server.listen(port, host, () => console.log('[axiom-gateway] listening on http://' + host + ':' + port));
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
