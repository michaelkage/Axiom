"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWorkerSecurityAudit, canonical, GENESIS_HASH } = require("./worker-security-audit.cjs");
const crypto = require("node:crypto");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-worker-audit-"));
  const filePath = path.join(root, "security", "worker-audit.jsonl");
  const signingKey = Buffer.alloc(32, 0x5a);
  let anchor = { sequence: 0, hash: "0".repeat(64) };
  const anchorStore = { get: () => anchor, set: value => { anchor = value; } };
  return { root, filePath, signingKey, anchorStore, audit: createWorkerSecurityAudit({ filePath, signingKey, anchorStore }) };
}

const decision = {
  permission: "bash",
  requestedDecision: "always",
  effectiveDecision: "once",
  sessionId: "session-123"
};

test("desktop worker audit uses authenticated chained records and durable append", async () => {
  const { filePath, audit } = fixture();
  const first = await audit.append(decision);
  const second = await audit.append({ ...decision, permission: "edit", requestedDecision: "reject", effectiveDecision: "reject" });
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
  assert.equal(second.previousHash, first.hash);
  assert.equal((await audit.verify()).valid, true);
  const listed = await audit.list();
  assert.equal(listed.total, 2);
  assert.equal(listed.records[0].sequence, 2);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});

test("tampering, truncation, and record reordering are detected", async () => {
  const { filePath, audit } = fixture();
  await audit.append(decision);
  await audit.append({ ...decision, permission: "edit" });
  const lines = fs.readFileSync(filePath, "utf8").trimEnd().split("\n");
  const changed = JSON.parse(lines[0]);
  changed.effectiveDecision = "always";
  lines[0] = JSON.stringify(changed);
  fs.writeFileSync(filePath, lines.join("\n") + "\n");
  assert.equal((await audit.verify()).valid, false);
  await assert.rejects(audit.append(decision), /authentication failed/i);
});

test("invalid permission metadata is rejected before persistence", async () => {
  const { audit } = fixture();
  await assert.rejects(audit.append({ ...decision, permission: "bash\nsecret-command" }), /Invalid worker permission category/);
  await assert.rejects(audit.append({ ...decision, sessionId: "bad\nsession" }), /Invalid worker session identifier/);
  assert.equal((await audit.list()).total, 0);
});

test("concurrent appends are serialized without duplicate sequence numbers", async () => {
  const { audit } = fixture();
  await Promise.all(Array.from({ length: 12 }, (_, index) => audit.append({ ...decision, sessionId: "session-" + index })));
  const listed = await audit.list();
  assert.equal(listed.total, 12);
  assert.deepEqual(listed.records.map(record => record.sequence), Array.from({ length: 12 }, (_, index) => 12 - index));
});


test("deleting the complete log is detected by the encrypted external checkpoint", async () => {
  const { filePath, audit } = fixture();
  await audit.append(decision);
  fs.unlinkSync(filePath);
  const result = await audit.verify();
  assert.equal(result.valid, false);
  assert.match(result.reason, /checkpoint mismatch/i);
});

test("audit file symlinks are rejected", async () => {
  const { root, filePath, audit } = fixture();
  const target = path.join(root, "attacker-controlled.jsonl");
  fs.writeFileSync(target, "");
  fs.symlinkSync(target, filePath);
  const result = await audit.verify();
  assert.equal(result.valid, false);
  assert.match(result.reason, /regular file/i);
});


test("recovers a durable authenticated append when a crash preceded checkpoint update", async () => {
  const { filePath, signingKey, anchorStore, audit } = fixture();
  const payload = {
    sequence: 1,
    timestamp: "2026-11-24T00:00:00.000Z",
    permission: "bash",
    requestedDecision: "always",
    effectiveDecision: "once",
    sessionId: "session-crash-recovery",
    previousHash: GENESIS_HASH
  };
  const hash = crypto.createHmac("sha256", signingKey).update(canonical(payload), "utf8").digest("hex");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ ...payload, hash }) + "\n", { mode: 0o600 });
  assert.equal(anchorStore.get().sequence, 0);
  const verified = await audit.verify();
  assert.equal(verified.valid, true);
  assert.equal(verified.records, 1);
  assert.deepEqual(anchorStore.get(), { sequence: 1, hash });
});
