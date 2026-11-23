"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_POLICY, createWorkspaceSecurityPolicyStore } = require("./workspace-security-policy.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "axiom-workspace-policy-"));
  const workspace = path.join(root, "project");
  fs.mkdirSync(workspace);
  return { root, workspace, store: createWorkspaceSecurityPolicyStore({ userDataPath: path.join(root, "user-data") }) };
}

test("workspace policy defaults to the least-privilege baseline and binds records to a workspace", () => {
  const f = fixture();
  try {
    const policy = f.store.read(f.workspace);
    assert.equal(policy.revision, 0);
    assert.deepEqual(policy.policy, DEFAULT_POLICY);
    assert.equal(f.store.evaluate(f.workspace, "shell.execute").decision, "approval-required");
    assert.equal(f.store.evaluate(f.workspace, "filesystem.read").decision, "allow");
    assert.equal(f.store.evaluate(f.workspace, "network.request").decision, "deny");
    assert.equal(f.store.evaluate(f.workspace, "unknown.operation").decision, "deny");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("policy updates are versioned, atomic and protected by optimistic revision checks", () => {
  const f = fixture();
  try {
    const first = f.store.update(f.workspace, { ...DEFAULT_POLICY, "filesystem.read": "deny" }, 0);
    assert.equal(first.revision, 1);
    assert.equal(f.store.evaluate(f.workspace, "filesystem.read").decision, "deny");
    assert.throws(() => f.store.update(f.workspace, DEFAULT_POLICY, 0), error => error.code === "POLICY_REVISION_CONFLICT");
    const second = f.store.update(f.workspace, { ...first.policy, "network.request": "approval-required" }, 1);
    assert.equal(second.revision, 2);
    assert.equal(f.store.read(f.workspace).revision, 2);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("policy validation rejects unknown actions and implicit privileged allow decisions", () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.update(f.workspace, { ...DEFAULT_POLICY, "shell.execute": "allow" }, 0), /Unsupported decision/);
    assert.throws(() => f.store.update(f.workspace, { ...DEFAULT_POLICY, extra: "allow" }, 0), /every supported action/);
    assert.throws(() => f.store.update(f.workspace, { ...DEFAULT_POLICY, "mcp.invoke": "allow" }, 0), /Unsupported decision/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("corrupt policy fails closed rather than silently restoring permissive defaults", () => {
  const f = fixture();
  try {
    const policyDir = path.join(f.root, "user-data", "security-policies");
    fs.mkdirSync(policyDir, { recursive: true });
    const id = require("node:crypto").createHash("sha256").update(path.resolve(f.workspace)).digest("hex").slice(0, 40);
    fs.writeFileSync(path.join(policyDir, id + ".json"), "{not-json");
    assert.equal(f.store.evaluate(f.workspace, "filesystem.read").decision, "deny");
    assert.match(f.store.evaluate(f.workspace, "filesystem.read").reason, /could not be loaded safely/);
    assert.throws(() => f.store.read(f.workspace));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("policy files cannot be symlinks and policy records cannot be replayed across workspaces", () => {
  const f = fixture();
  const other = path.join(f.root, "other");
  fs.mkdirSync(other);
  try {
    const policyDir = path.join(f.root, "user-data", "security-policies");
    fs.mkdirSync(policyDir, { recursive: true });
    const id = require("node:crypto").createHash("sha256").update(path.resolve(f.workspace)).digest("hex").slice(0, 40);
    const outside = path.join(f.root, "outside.json");
    fs.writeFileSync(outside, "{}");
    fs.symlinkSync(outside, path.join(policyDir, id + ".json"));
    assert.throws(() => f.store.read(f.workspace), /unsafe or oversized/);
    assert.equal(f.store.evaluate(f.workspace, "shell.execute").decision, "deny");
    fs.unlinkSync(path.join(policyDir, id + ".json"));
    f.store.update(f.workspace, DEFAULT_POLICY, 0);
    assert.equal(f.store.read(other).revision, 0);
    assert.equal(f.store.read(other).workspaceRoot, path.resolve(other));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("network policy requires HTTPS exact-host allowlisting and honors approved browser origins", () => {
  const f = fixture();
  try {
    const policy = { ...DEFAULT_POLICY, "network.allowedHosts": ["docs.example.com"] };
    f.store.update(f.workspace, policy, 0);
    assert.equal(f.store.evaluateNetworkRequest(f.workspace, "https://docs.example.com/api").decision, "allow");
    assert.equal(f.store.evaluateNetworkRequest(f.workspace, "https://evil.example.com/").decision, "deny");
    assert.equal(f.store.evaluateNetworkRequest(f.workspace, "http://docs.example.com/").decision, "deny");
    assert.equal(f.store.evaluateNetworkRequest(f.workspace, "https://docs.example.com.evil.test/").decision, "deny");
    assert.equal(f.store.evaluateNetworkRequest(f.workspace, "https://approved.example.com/", ["https://approved.example.com"]).decision, "allow");
    assert.throws(() => f.store.update(f.workspace, { ...policy, "network.allowedHosts": ["*.example.com"] }, 1), /exact hostnames/);
    assert.throws(() => f.store.update(f.workspace, { ...policy, "network.allowedHosts": ["127.0.0.1"] }, 1), /Loopback and IP literals/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
