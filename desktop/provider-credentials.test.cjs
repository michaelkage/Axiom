"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderCredentialManager, validateProviderSecret } = require("./provider-credentials.cjs");

function fixture() {
  const secrets = new Map();
  return {
    secrets,
    manager: createProviderCredentialManager({
      get: (namespace, key) => secrets.get(namespace + ":" + key) || null,
      set: (namespace, key, value) => secrets.set(namespace + ":" + key, value),
      remove: (namespace, key) => secrets.delete(namespace + ":" + key),
    }),
  };
}

test("stores GitHub and Supabase PATs in secure storage without returning secret material", () => {
  const { manager, secrets } = fixture();
  const github = "github_pat_" + "a".repeat(40);
  const supabase = "sbp_" + "b".repeat(40);
  assert.deepEqual(manager.save("github", github), { providerId: "github", configured: true });
  assert.deepEqual(manager.save("supabase", supabase), { providerId: "supabase", configured: true });
  assert.equal(secrets.size, 2);
  assert.deepEqual(manager.status("github"), { providerId: "github", configured: true });
  assert.deepEqual(manager.status("supabase"), { providerId: "supabase", configured: true });
  assert.equal(JSON.stringify(manager.status("github")).includes(github), false);
});

test("rejects malformed or cross-provider credentials", () => {
  assert.throws(() => validateProviderSecret("github", "sbp_" + "x".repeat(40)), /format/);
  assert.throws(() => validateProviderSecret("supabase", "ghp_" + "x".repeat(40)), /format/);
  assert.throws(() => validateProviderSecret("github", "ghp_" + "x".repeat(10)), /bounded/);
  assert.throws(() => validateProviderSecret("unknown", "x".repeat(30)), /Unsupported/);
});

test("removes a credential and reports only configuration metadata", () => {
  const { manager } = fixture();
  manager.save("github", "ghp_" + "x".repeat(40));
  assert.deepEqual(manager.remove("github"), { providerId: "github", configured: false });
  assert.deepEqual(manager.status("github"), { providerId: "github", configured: false });
});
