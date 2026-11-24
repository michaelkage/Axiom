"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const GENESIS_HASH = "0".repeat(64);
const MAX_AUDIT_FILE_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS_RETURNED = 1000;

function canonical(record) {
  return JSON.stringify({
    sequence: record.sequence,
    timestamp: record.timestamp,
    permission: record.permission,
    requestedDecision: record.requestedDecision,
    effectiveDecision: record.effectiveDecision,
    sessionId: record.sessionId,
    previousHash: record.previousHash
  });
}

function createWorkerSecurityAudit({ filePath, signingKey, anchorStore, fsImpl = fs, now = () => new Date() }) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) throw new Error("An absolute worker audit path is required.");
  if (!Buffer.isBuffer(signingKey) || signingKey.length !== 32) throw new Error("A 32-byte OS-protected worker audit signing key is required.");
  if (!anchorStore || typeof anchorStore.get !== "function" || typeof anchorStore.set !== "function") throw new Error("An OS-protected worker audit checkpoint store is required.");
  let queue = Promise.resolve();

  function digest(value) {
    return crypto.createHmac("sha256", signingKey).update(value, "utf8").digest("hex");
  }

  function readRaw() {
    try {
      const stat = fsImpl.lstatSync(filePath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_AUDIT_FILE_BYTES) throw new Error("Worker audit file is not a regular file or exceeds the size limit.");
      return fsImpl.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error && error.code === "ENOENT") return "";
      throw error;
    }
  }

  function parseAndVerify() {
    const raw = readRaw();
    if (!raw) return [];
    if (!raw.endsWith("\n")) throw new Error("Worker audit log has an incomplete final record.");
    const lines = raw.slice(0, -1).split("\n");
    const records = [];
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < lines.length; index += 1) {
      let record;
      try { record = JSON.parse(lines[index]); }
      catch { throw new Error("Worker audit log contains invalid JSON at record " + (index + 1) + "."); }
      const expectedKeys = ["sequence", "timestamp", "permission", "requestedDecision", "effectiveDecision", "sessionId", "previousHash", "hash"];
      if (!record || typeof record !== "object" || Object.keys(record).sort().join(",") !== expectedKeys.sort().join(",")) {
        throw new Error("Worker audit record schema mismatch at record " + (index + 1) + ".");
      }
      if (record.sequence !== index + 1 || record.previousHash !== previousHash) throw new Error("Worker audit chain linkage failed at record " + (index + 1) + ".");
      const expectedHash = digest(canonical(record));
      const actual = Buffer.from(String(record.hash), "hex");
      const expected = Buffer.from(expectedHash, "hex");
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("Worker audit authentication failed at record " + (index + 1) + ".");
      previousHash = record.hash;
      records.push(record);
    }
    const anchor = anchorStore.get();
    if (!anchor || !Number.isSafeInteger(anchor.sequence) || anchor.sequence < 0 || typeof anchor.hash !== "string" || !/^[a-f0-9]{64}$/.test(anchor.hash)) {
      throw new Error("Worker audit checkpoint is missing or malformed.");
    }
    const anchoredHash = anchor.sequence === 0 ? GENESIS_HASH : records[anchor.sequence - 1]?.hash;
    if (anchor.sequence > records.length || anchoredHash !== anchor.hash) {
      throw new Error("Worker audit checkpoint mismatch; truncation or replacement detected.");
    }
    // A crash can occur after fsync of the log record but before the encrypted
    // checkpoint update. Advance only when the authenticated chain extends the
    // previous checkpoint; forged records cannot pass the HMAC verification.
    if (records.length > anchor.sequence) {
      const latest = records[records.length - 1];
      anchorStore.set({ sequence: latest.sequence, hash: latest.hash });
    }
    return records;
  }

  function enqueue(operation) {
    const result = queue.then(operation, operation);
    queue = result.catch(() => {});
    return result;
  }

  function validateInput(input) {
    if (!input || typeof input !== "object") throw new Error("Invalid worker audit input.");
    if (typeof input.permission !== "string" || !/^[a-zA-Z0-9_.:-]{1,80}$/.test(input.permission)) throw new Error("Invalid worker permission category.");
    if (!["once", "always", "reject"].includes(input.requestedDecision) || !["once", "always", "reject"].includes(input.effectiveDecision)) throw new Error("Invalid worker permission decision.");
    if (typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 160 || /[\r\n\0]/.test(input.sessionId)) throw new Error("Invalid worker session identifier.");
  }

  async function append(input) {
    return enqueue(async () => {
      validateInput(input);
      const records = parseAndVerify();
      const previousHash = records.length ? records[records.length - 1].hash : GENESIS_HASH;
      const payload = {
        sequence: records.length + 1,
        timestamp: now().toISOString(),
        permission: input.permission,
        requestedDecision: input.requestedDecision,
        effectiveDecision: input.effectiveDecision,
        sessionId: input.sessionId,
        previousHash
      };
      const record = { ...payload, hash: digest(canonical(payload)) };
      const directory = path.dirname(filePath);
      await fsImpl.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await fsImpl.promises.lstat(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error("Worker audit directory is not a trusted regular directory.");
      await fsImpl.promises.chmod(directory, 0o700);
      const noFollow = fsImpl.constants && fsImpl.constants.O_NOFOLLOW ? fsImpl.constants.O_NOFOLLOW : 0;
      const flags = fsImpl.constants.O_WRONLY | fsImpl.constants.O_CREAT | fsImpl.constants.O_APPEND | noFollow;
      const handle = await fsImpl.promises.open(filePath, flags, 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(JSON.stringify(record) + "\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const verified = parseAndVerify();
      if (verified.length !== records.length + 1 || verified[verified.length - 1].hash !== record.hash) {
        throw new Error("Worker audit append could not be verified after durable write.");
      }
      anchorStore.set({ sequence: record.sequence, hash: record.hash });
      const anchored = anchorStore.get();
      if (!anchored || anchored.sequence !== record.sequence || anchored.hash !== record.hash) {
        throw new Error("Worker audit checkpoint could not be persisted.");
      }
      return record;
    });
  }

  async function list() {
    return enqueue(async () => {
      const records = parseAndVerify();
      return { valid: true, total: records.length, records: records.slice(-MAX_RECORDS_RETURNED).reverse() };
    });
  }

  async function verify() {
    return enqueue(async () => {
      try {
        const records = parseAndVerify();
        return { valid: true, records: records.length, latestHash: records.length ? records[records.length - 1].hash : GENESIS_HASH };
      } catch (error) {
        return { valid: false, records: 0, reason: error instanceof Error ? error.message : String(error) };
      }
    });
  }

  return Object.freeze({ append, list, verify });
}

module.exports = { createWorkerSecurityAudit, canonical, GENESIS_HASH, MAX_AUDIT_FILE_BYTES, MAX_RECORDS_RETURNED };
