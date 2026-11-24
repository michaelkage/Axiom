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
  if (Array.isArray(message)) {
    return message.some(item => item && typeof item === 'object' && item.method === 'tools/call')
      ? { invalid: true, name: null, requestId: null }
      : null;
  }
  if (!message || typeof message !== 'object') return null;
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
      let sequence = 0;
      try {
        const content = await readFile(path, 'utf8');
        const lines = content.split('\\n');
        if (lines.at(-1) === '') lines.pop();
        for (const line of lines) {
          if (!line) throw new Error('Audit chain contains an empty record.');
          const record = JSON.parse(line);
          const { hash, ...payload } = record;
          const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
          if (record.previousHash !== previousHash || record.sequence !== sequence + 1 || hash !== expected) {
            throw new Error('Audit chain integrity verification failed.');
          }
          previousHash = hash;
          sequence += 1;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const payload = { ...event, sequence: sequence + 1, timestamp: new Date(now()).toISOString(), previousHash };
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
