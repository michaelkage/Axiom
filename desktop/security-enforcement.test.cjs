"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeRelativePath, evaluateFilesystemAccess, createSecurityAuditStore } = require("./security-enforcement.cjs");

test("filesystem policy allows safe reads and requires approval for writes", () => {
  const root = path.resolve(os.tmpdir(), "axiom-project");
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: root, relativePath: "src/index.ts", operation: "read" }).decision, "allow");
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: root, relativePath: "src/index.ts", operation: "write" }).decision, "approval-required");
});

test("filesystem policy denies traversal, absolute paths, secrets and dependency trees", () => {
  for (const value of ["../outside", "/etc/passwd", "C:\\Windows\\win.ini", ".env", ".env.production", "node_modules/pkg/a.js", ".git/config", "src/../../outside"]) {
    assert.throws(() => normalizeRelativePath(value));
  }
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: "/tmp/project", relativePath: "../outside", operation: "read" }).decision, "deny");
  assert.equal(evaluateFilesystemAccess({ workspaceRoot: null, relativePath: "src/a", operation: "read" }).decision, "deny");
});

test("security audit records structured bounded events and ignores corrupt lines", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-security-audit-"));
  try {
    const audit = createSecurityAuditStore({ userDataPath: root });
    audit.record({ action: "filesystem.write", decision: "approval-required", reason: "Approval required", projectId: "abc", resource: "src/a.ts" });
    fs.appendFileSync(path.join(root, "security-audit.jsonl"), "corrupt\n");
    const rows = audit.list();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, "desktop-main");
    assert.equal(rows[0].decision, "approval-required");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("security audit history rotates at its configured size bound", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-security-rotation-"));
  try {
    const file = path.join(root, "security-audit.jsonl");
    const row = JSON.stringify({
      schemaVersion: 1, timestamp: new Date().toISOString(), action: "test",
      decision: "allow", reason: "r".repeat(500), projectId: "p".repeat(128),
      resource: "x".repeat(512), actor: "desktop-main"
    });
    fs.writeFileSync(file, Array.from({ length: 5000 }, () => row).join("\n") + "\n");
    const audit = createSecurityAuditStore({ userDataPath: root });
    audit.record({ action: "rotation.check", decision: "allow", reason: "new event" });
    const events = audit.list(1000);
    assert.equal(events.at(-1).action, "rotation.check");
    assert.ok(fs.statSync(file).size < 7 * 1024 * 1024);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("security audit store refuses a symlinked audit destination", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-security-link-"));
  const outside = path.join(root, "outside.jsonl");
  const auditPath = path.join(root, "security-audit.jsonl");
  try {
    fs.writeFileSync(outside, "private");
    fs.symlinkSync(outside, auditPath);
    const audit = createSecurityAuditStore({ userDataPath: root });
    assert.throws(() => audit.record({ action: "test", decision: "allow" }), /regular file/);
    assert.equal(fs.readFileSync(outside, "utf8"), "private");
    assert.throws(() => audit.list(), /regular file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
