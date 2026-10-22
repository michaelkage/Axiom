"use strict";

const path = require("node:path");

/**
 * Keep the bundled runtime's user data in Axiom's app-specific data directory.
 * APPDATA is used by Windows path resolution; XDG_DATA_HOME covers Linux.
 * Existing shared databases are deliberately left untouched for recovery.
 */
function createRuntimeEnvironment(baseEnvironment, userDataPath) {
  const runtimeDataPath = path.join(userDataPath, "runtime-data");
  return {
    ...baseEnvironment,
    APPDATA: path.join(runtimeDataPath, "roaming"),
    XDG_DATA_HOME: runtimeDataPath
  };
}

module.exports = { createRuntimeEnvironment };
