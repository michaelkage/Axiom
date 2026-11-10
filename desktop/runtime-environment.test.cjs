"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRuntimeEnvironment } = require("./runtime-environment.cjs");

test("isolates runtime data under Axiom user data without changing other environment values", () => {
  const env = createRuntimeEnvironment({
    PATH: "system-path",
    HOME: "user-home",
    XDG_DATA_HOME: "shared-runtime-data",
    APPDATA: "shared-runtime-appdata",
    OPENCODE_CONFIG_CONTENT: "{\"model\":\"configured\"}"
  }, path.join("C:", "Users", "tester", "AppData", "Roaming", "Axiom"));

  assert.equal(
    env.XDG_DATA_HOME,
    path.join("C:", "Users", "tester", "AppData", "Roaming", "Axiom", "runtime-data")
  );
  assert.equal(env.APPDATA, path.join("C:", "Users", "tester", "AppData", "Roaming", "Axiom", "runtime-data", "roaming"));
  assert.equal(env.PATH, "system-path");
  assert.equal(env.HOME, "user-home");
  assert.equal(env.OPENCODE_CONFIG_CONTENT, "{\"model\":\"configured\"}");
});

test("uses a dedicated persistent data directory for each app profile", () => {
  const first = createRuntimeEnvironment({}, path.join("/profiles", "axiom"));
  const second = createRuntimeEnvironment({}, path.join("/profiles", "other-app"));
  assert.notEqual(first.XDG_DATA_HOME, second.XDG_DATA_HOME);
  assert.equal(first.XDG_DATA_HOME, path.join("/profiles", "axiom", "runtime-data"));
  assert.equal(first.APPDATA, path.join("/profiles", "axiom", "runtime-data", "roaming"));
});
