"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const desktop = JSON.parse(fs.readFileSync(path.join(__dirname, "package.json"), "utf8"));
const platformWorkflow = fs.readFileSync(path.join(root, ".github/workflows/release-platforms.yml"), "utf8");
const runtime = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("macOS packaging defines Intel and Apple Silicon DMG and ZIP targets", () => {
  const targets = desktop.build.mac.target;
  assert.deepEqual(targets.map(target => target.target).sort(), ["dmg", "zip"]);
  for (const target of targets) assert.deepEqual([...target.arch].sort(), ["arm64", "x64"]);
  assert.equal(desktop.build.mac.hardenedRuntime, true);
  assert.equal(desktop.build.mac.entitlements, "build/entitlements.mac.plist");
  assert.ok(desktop.build.files.includes("secure-storage.cjs"), "The Electron credential vault must ship inside the app.");
});

test("macOS release workflow builds both architectures and accepts signing credentials", () => {
  assert.match(platformWorkflow, /arch: x64[\s\S]*?arch: arm64/);
  assert.match(platformWorkflow, /runner: macos-15/);
  assert.doesNotMatch(platformWorkflow, /runner: macos-14/);
  assert.match(platformWorkflow, /APPLE_CERTIFICATE_P12_BASE64/);
  assert.match(platformWorkflow, /APPLE_APP_SPECIFIC_PASSWORD/);
  assert.match(platformWorkflow, /APPLE_TEAM_ID/);
  assert.match(platformWorkflow, /--publish never/);
  assert.match(platformWorkflow, /env\.APPLE_CERTIFICATE_P12_BASE64 !=/);
  assert.match(platformWorkflow, /branches:\s*\n\s*- "main"/);
});

test("runtime resolver checks architecture-specific native binaries before generic shims", () => {
  assert.match(runtime, /"opencode-" \+ process\.platform \+ "-" \+ process\.arch/);
  assert.match(runtime, /app\.isPackaged/);
});
