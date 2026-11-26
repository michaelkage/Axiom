import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, open, rename, unlink, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
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

export function createAuditChain({ path, key, now = Date.now } = {}) {
  if (!path) throw new Error('An audit log path is required.');
  if (!(typeof key === 'string' || Buffer.isBuffer(key)) || Buffer.byteLength(key) < 32) {
    throw new Error('An audit signing key of at least 32 bytes is required.');
  }
  const signingKey = Buffer.from(key);
  let tail = Promise.resolve();

  const digest = payload => createHmac('sha256', signingKey).update(JSON.stringify(payload)).digest('hex');
  const equalDigest = (left, right) => {
    if (typeof left !== 'string' || typeof right !== 'string' || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
    return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
  };

  function verifyLegacy(content) {
    let previousHash = '0'.repeat(64);
    let sequence = 0;
    const records = [];
    const lines = content.split('\\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      if (!line) throw new Error('Audit chain contains an empty record.');
      let record;
      try { record = JSON.parse(line); } catch { throw new Error('Audit chain contains an invalid record.'); }
      const { hash, ...payload } = record;
      const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
      if (record.previousHash !== previousHash || record.sequence !== sequence + 1 || hash !== expected) {
        throw new Error('Audit chain integrity verification failed.');
      }
      previousHash = hash;
      sequence += 1;
      records.push(payload);
    }
    return records;
  }

  function verifySigned(content) {
    let previousHash = '0'.repeat(64);
    let sequence = 0;
    const lines = content.split('\\n');
    if (lines.at(-1) === '') lines.pop();
    for (const line of lines) {
      if (!line) throw new Error('Audit chain contains an empty record.');
      let record;
      try { record = JSON.parse(line); } catch { throw new Error('Audit chain contains an invalid record.'); }
      const { hash, ...payload } = record;
      if (payload.version !== 2 || payload.previousHash !== previousHash ||
          payload.sequence !== sequence + 1 || !equalDigest(hash, digest(payload))) {
        throw new Error('Audit chain integrity verification failed.');
      }
      previousHash = hash;
      sequence += 1;
    }
    return { previousHash, sequence };
  }

  async function persistSigned(records) {
    const serialized = records.map(payload => {
      const signed = { ...payload, version: 2 };
      return JSON.stringify({ ...signed, hash: digest(signed) });
    }).join('\\n') + (records.length ? '\\n' : '');
    const temporaryPath = path + '.migrate-' + process.pid + '-' + randomBytes(8).toString('hex');
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(serialized, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporaryPath, path);
      await chmod(path, 0o600);
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }

  async function append(event) {
    const operation = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      let previousHash = '0'.repeat(64);
      let sequence = 0;
      try {
        const content = await readFile(path, 'utf8');
        const firstLine = content.split('\\n', 1)[0];
        let records;
        try {
          const first = JSON.parse(firstLine);
          if (first.version === 2) {
            ({ previousHash, sequence } = verifySigned(content));
          } else {
            records = verifyLegacy(content);
            await persistSigned(records);
            if (records.length) {
              const last = records[records.length - 1];
              previousHash = digest({ ...last, version: 2 });
              sequence = records.length;
            }
          }
        } catch (error) {
          if (error.message === 'Audit chain integrity verification failed.' ||
              error.message === 'Audit chain contains an empty record.' ||
              error.message === 'Audit chain contains an invalid record.') throw error;
          throw new Error('Audit chain integrity verification failed.');
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const payload = {
        ...event,
        version: 2,
        sequence: sequence + 1,
        timestamp: new Date(now()).toISOString(),
        previousHash
      };
      const hash = digest(payload);
      const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW || 0), 0o600);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error('Audit log must be a regular file.');
        await handle.writeFile(JSON.stringify({ ...payload, hash }) + '\\n', 'utf8');
        await handle.sync();
        await handle.chmod(0o600);
      } finally {
        await handle.close();
      }
      return hash;
    });
    tail = operation.catch(() => {});
    return operation;
  }
  return { append };
}
