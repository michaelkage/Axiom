import test from "node:test";
import assert from "node:assert/strict";
import { validateProjectConfig } from "../src/lib/projectConfig.js";

test("validates and normalizes a versioned project configuration", () => {
  const config = validateProjectConfig({ schemaVersion: 1, conventions: ["Use TypeScript"], skills: ["code-review", "code-review"], qualityGates: [{ name: "Unit tests", command: "npm test" }] });
  assert.deepEqual(config.skills, ["code-review"]);
  assert.equal(config.qualityGates[0].command, "npm test");
});

test("rejects shell metacharacters in quality gate commands", () => {
  assert.throws(() => validateProjectConfig({ schemaVersion: 1, qualityGates: [{ name: "Unsafe", command: "npm test && rm -rf ." }] }), /validated command/);
});

test("rejects unsupported schema versions and oversized config", () => {
  assert.throws(() => validateProjectConfig({ schemaVersion: 2 }), /version/);
  assert.throws(() => validateProjectConfig({ schemaVersion: 1, conventions: ["x".repeat(40000)] }), /32 KiB/);
});
