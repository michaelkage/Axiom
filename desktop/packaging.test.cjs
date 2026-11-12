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

test("all transitive local runtime dependencies are included in the packaged app", () => {
  const packagedFiles = new Set(desktop.build.files);
  const visited = new Set();

  const inspectModule = (modulePath) => {
    assert.ok(packagedFiles.has(modulePath), `Electron package must include runtime dependency: ${modulePath}`);
    if (visited.has(modulePath)) return;
    visited.add(modulePath);

    const absolutePath = path.resolve(__dirname, modulePath);
    const relativePath = path.relative(__dirname, absolutePath);
    assert.ok(relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath), `Runtime dependency escapes desktop package: ${modulePath}`);
    assert.ok(fs.existsSync(absolutePath), `Packaged runtime dependency does not exist: ${modulePath}`);

    const source = fs.readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(/require\(["'](\.\/[^"']+)["']\)/g)) {
      const request = match[1];
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(modulePath), request));
      const candidates = path.posix.extname(base)
        ? [base]
        : [base + ".cjs", base + ".js", base + ".json", path.posix.join(base, "index.cjs"), path.posix.join(base, "index.js")];
      const dependency = candidates.find(candidate => packagedFiles.has(candidate) && fs.existsSync(path.resolve(__dirname, candidate)));
      assert.ok(dependency, `Unpackaged local dependency ${request} imported by ${modulePath}`);
      inspectModule(dependency);
    }
  };

  for (const modulePath of desktop.build.files.filter(file => file.endsWith(".cjs"))) {
    inspectModule(modulePath);
  }
});

