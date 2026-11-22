"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createPluginRuntime, validatePluginManifest } = require("./plugin-runtime.cjs");

const PLUGIN_DIRECTORY = "axiom-plugins";

function createPluginHost(options = {}) {
  if (typeof options.root !== "string" || !path.isAbsolute(options.root)) throw new TypeError("Plugin host root must be an absolute path.");
  if (typeof options.authorize !== "function" || typeof options.spawnSandbox !== "function") throw new TypeError("Plugin host requires native authorization and an OS sandbox adapter.");
  const root = path.resolve(options.root);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const realRoot = fs.realpathSync(root);
  const runtime = createPluginRuntime({ pluginRoot: realRoot, authorize: options.authorize, spawnSandbox: options.spawnSandbox });

  function readManifest(id) {
    if (typeof id !== "string" || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(id)) throw new TypeError("Invalid plugin identifier.");
    const directory = path.join(realRoot, id);
    const realDirectory = fs.realpathSync(directory);
    if (realDirectory !== path.join(realRoot, id) || !realDirectory.startsWith(realRoot + path.sep) || !fs.statSync(realDirectory).isDirectory()) {
      throw new Error("Plugin installation directory is invalid.");
    }
    const manifestPath = path.join(realDirectory, "manifest.json");
    const stat = fs.lstatSync(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32 * 1024) throw new Error("Plugin manifest is missing, unsafe or oversized.");
    const manifest = validatePluginManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")));
    if (manifest.id !== id) throw new Error("Plugin manifest ID does not match its installation directory.");
    return manifest;
  }

  function list() {
    return fs.readdirSync(realRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-z0-9][a-z0-9._-]{1,63}$/.test(entry.name))
      .flatMap(entry => {
        try {
          const manifest = readManifest(entry.name);
          return [{ id: manifest.id, name: manifest.name, capabilities: [...manifest.capabilities], resources: { ...manifest.resources } }];
        } catch { return []; }
      });
  }

  async function run(id, request = {}) {
    const manifest = readManifest(id);
    return runtime.run(manifest, request);
  }

  return Object.freeze({ list, run, root: realRoot });
}

module.exports = { createPluginHost, PLUGIN_DIRECTORY };
