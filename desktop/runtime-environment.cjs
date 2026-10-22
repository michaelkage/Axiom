"use strict";

const path = require("node:path");

/**
 * Keep the bundled runtime's database under Axiom's app-specific user-data
 * directory instead of sharing a database with another installation/version.
 * Existing databases are deliberately left untouched for recovery.
 */
function createRuntimeEnvironment(baseEnvironment, userDataPath) {
  return {
    ...baseEnvironment,
    XDG_DATA_HOME: path.join(userDataPath, "runtime-data")
  };
}

module.exports = { createRuntimeEnvironment };
