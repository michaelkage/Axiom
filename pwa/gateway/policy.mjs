import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';

const TOOL_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
const MAX_POLICY_BYTES = 64 * 1024;

export function parseMcpPolicy(value = '{}') {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_POLICY_BYTES) {
    throw new Error('AXIOM_MCP_POLICY_JSON exceeds the policy size limit.');
  }
  let parsed;
  try { parsed = JSON.parse(value); } catch { throw new Error('AXIOM_MCP_POLICY_JSON must be valid JSON.'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('MCP policy must be an object.');
  const policy = Object.create(null);
  for (const [serverId, rule] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(serverId) || !rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error('Invalid MCP policy entry: ' + serverId);
    }
    if (!Array.isArray(rule.allowedTools) || rule.allowedTools.length > 512 ||
        rule.allowedTools.some(name => typeof name !== 'string' || !TOOL_NAME.test(name)) ||
        new Set(rule.allowedTools).size !== rule.allowedTools.length) {
      throw new Error('MCP policy for ' + serverId + ' must contain a unique allowedTools array.');
    }
    policy[serverId] = Object.freeze({ allowedTools: new Set(rule.allowedTools) });
  }
  return policy;
}

export function inspectMcpToolCall(body) {
  let message;
  try { message = JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (message.method !== 'tools/call') return null;
  const name = message.params?.name;
  if (typeof name !== 'string' || !TOOL_NAME.test(name)) return { invalid: true, name: null };
  return { invalid: false, name, requestId: message.id ?? null };
}

export function createAuditChain({ path, now = Date.now } = {}) {
  if (!path) throw new Error('An audit log path is required.');
  let tail = Promise.resolve();
  async function append(event) {
    const operation = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let previousHash = '0'.repeat(64);
      try {
        const content = await readFile(path, 'utf8');
        const lines = content.split('\n').filter(Boolean);
        if (lines.length) {
          const last = JSON.parse(lines[lines.length - 1]);
          const { hash, ...payload } = last;
          const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
          if (hash !== expected) throw new Error('Audit chain integrity verification failed.');
          previousHash = hash;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const payload = { sequence: previousHash === '0'.repeat(64) ? 1 : undefined, timestamp: new Date(now()).toISOString(), previousHash, ...event };
      if (payload.sequence === undefined) {
        const content = await readFile(path, 'utf8');
        payload.sequence = content.split('\n').filter(Boolean).length + 1;
      }
      const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      await appendFile(path, JSON.stringify({ ...payload, hash }) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'a' });
      await chmod(path, 0o600);
      return hash;
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return { append };
}
