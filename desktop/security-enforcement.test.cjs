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
