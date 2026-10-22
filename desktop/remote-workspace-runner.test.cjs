"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { safeRemoteUrl } = require("./remote-workspace-runner.cjs");

test("remote workspace runner rejects embedded credentials", () => {
  assert.throws(() => safeRemoteUrl("https://user:token@example.com/org/repo.git"), /embedded credentials/);
  assert.throws(() => safeRemoteUrl("https://example.com/org/repo.git?token=secret"), /embedded credentials/);
});
test("remote workspace runner accepts credential-free HTTPS and SSH remotes", () => {
  assert.equal(safeRemoteUrl("https://github.com/org/repo.git"), "https://github.com/org/repo.git");
  assert.equal(safeRemoteUrl("git@github.com:org/repo.git"), "git@github.com:org/repo.git");
});
