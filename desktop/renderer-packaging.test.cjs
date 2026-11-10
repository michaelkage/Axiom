const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const outputRoot = path.join(root, "out");
const launcher = path.join(outputRoot, "src", "webview", "standalone.html");
const desktopPackage = require("./package.json");

test("packaged renderer entry and local assets exist", () => {
  assert.ok(desktopPackage.build.extraResources.some(resource =>
    resource.from === "../out" && resource.to === "out"
  ), "electron-builder must copy the built renderer into resources/out");

  assert.ok(fs.existsSync(launcher), "Vite must emit the standalone desktop HTML entry");
  const html = fs.readFileSync(launcher, "utf8");
  assert.match(html, /<div[^>]+id=["']root["']/i, "renderer entry must contain the mount root");

  const localAssets = [
    ...html.matchAll(/(?:src|href)=["']([^"']+)["']/g),
  ].map(match => match[1]).filter(value =>
    !/^(?:[a-z]+:|#|\/\/)/i.test(value)
  );
  assert.ok(localAssets.length > 0, "built renderer must reference local assets");
  for (const asset of localAssets) {
    const resolved = path.resolve(path.dirname(launcher), asset);
    assert.ok(
      resolved.startsWith(outputRoot + path.sep) && fs.existsSync(resolved),
      `renderer asset must exist inside packaged output: ${asset}`
    );
  }
});


test("desktop host records renderer startup diagnostics", () => {
  const mainProcess = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(mainProcess, /webContents\.on\(["']did-fail-load["']/,
    "renderer navigation failures must be written to the runtime log");
  assert.match(mainProcess, /webContents\.on\(["']console-message["']/,
    "renderer console errors must be written to the runtime log");
  assert.match(mainProcess, /Axiom UI mount failed/,
    "a loaded but unmounted renderer must be distinguishable from a successful startup");
});
