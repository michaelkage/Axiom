"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeRelativePath, evaluateFilesystemAccess, combineFilesystemDecisions, createSecurityAuditStore } = require("./security-enforcement.cjs");
const AUDIT_KEY = "a".repeat(64);
function auditFixture(root) {
  let anchor = null;
  return createSecurityAuditStore({ userDataPath: root, integrityKey: AUDIT_KEY, getAnchor: () => anchor, setAnchor: value => { anchor = value; } });
}

test("filesystem policy allows safe reads and requires approval for writes", () => {
  const root = path.resolve(os.tmpdir(), "axiom-project");
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: root, relativePath: "src/index.ts", operation: "read" }).decision, "allow");
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: root, relativePath: "src/index.ts", operation: "write" }).decision, "approval-required");
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: root, relativePath: "", operation: "write" }).decision, "deny");
});

test("filesystem policy denies traversal, absolute paths, secrets and dependency trees", () => {
  for (const value of ["../outside", "/etc/passwd", "C:\\Windows\\win.ini", ".env", ".env.production", "node_modules/pkg/a.js", ".git/config", "src/../../outside", ".ssh/id_ed25519", ".aws/credentials", "certs/private.pem", "secrets/signing.key"]) {
    assert.throws(() => normalizeRelativePath(value));
  }
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: "/tmp/project", relativePath: "../outside", operation: "read" }).decision, "deny");
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: null, relativePath: "src/a", operation: "read" }).decision, "deny");
});

test("security audit writes a verifiable HMAC chain and rejects altered events", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-security-audit-"));
  try {
    const audit = auditFixture(root);
    audit.record({ action: "filesystem.write", decision: "approval-required", reason: "Approval required", projectId: "abc", resource: "src/a.ts" });
    audit.record({ action: "filesystem.write", decision: "allow", reason: "Native approval granted" });
    const rows = audit.list();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].actor, "desktop-main");
    assert.equal(rows[0].decision, "approval-required");
    assert.equal(rows[1].sequence, 2);
    assert.equal(rows[1].previousHash, rows[0].hash);
    assert.equal(audit.verify(), 2);
    const file = path.join(root, "security-audit.jsonl");
    const changed = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\\n")[0]);
    changed.reason = "tampered";
    const lines = fs.readFileSync(file, "utf8").trim().split("\\n");
    lines[0] = JSON.stringify(changed);
    fs.writeFileSync(file, lines.join("\\n") + "\\n");
    assert.throws(() => audit.list(), /integrity verification failed/);
    assert.throws(() => audit.record({ action: "privileged.test", decision: "allow" }), /integrity verification failed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("security audit protected head anchor detects tail truncation and log deletion", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-security-anchor-"));
  try {
    const audit = auditFixture(root);
    audit.record({ action: "one", decision: "allow" });
    audit.record({ action: "two", decision: "allow" });
    const file = path.join(root, "security-audit.jsonl");
    const lines = fs.readFileSync(file, "utf8").trim().split("\\n");
    fs.writeFileSync(file, lines[0] + "\\n");
    assert.throws(() => audit.list(), /integrity verification failed|protected integrity anchor/);
    fs.unlinkSync(file);
    assert.throws(() => audit.list(), /missing but its protected integrity anchor exists/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("security audit refuses writes without a valid OS-protected integrity key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-security-key-"));
  try {
    assert.throws(() => createSecurityAuditStore({ userDataPath: root }), /256-bit OS-protected/);
    assert.throws(() => createSecurityAuditStore({ userDataPath: root, integrityKey: "short" }), /256-bit OS-protected/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("security audit store refuses a symlinked audit destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-security-link-"));
  const outside = path.join(root, "outside.jsonl");
  const auditPath = path.join(root, "security-audit.jsonl");
  try {
    fs.writeFileSync(outside, "private");
    fs.symlinkSync(outside, auditPath);
    const audit = auditFixture(root);
    assert.throws(() => audit.record({ action: "test", decision: "allow" }), /unsafe or oversized/);
    assert.equal(fs.readFileSync(outside, "utf8"), "private");
    assert.throws(() => audit.list(), /unsafe or oversized/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("filesystem authorization composes path and workspace policy with deny precedence", () => {
  const allow = { decision: "allow", reason: "base" };
  const denied = { decision: "deny", reason: "policy denied" };
  const approval = { decision: "approval-required", reason: "approval required" };
  assert.equal(combineFilesystemDecisions(allow, allow).decision, "allow");
  assert.equal(combineFilesystemDecisions(approval, allow).decision, "approval-required");
  assert.equal(combineFilesystemDecisions(allow, approval).decision, "approval-required");
  assert.deepEqual(combineFilesystemDecisions(allow, denied), denied);
  assert.equal(combineFilesystemDecisions(denied, allow).decision, "deny");
  assert.equal(combineFilesystemDecisions(allow, null).decision, "deny");
});
