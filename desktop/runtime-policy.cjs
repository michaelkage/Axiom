"use strict";

const EFFECTS = Object.freeze({
  allow: "allow",
  "approval-required": "ask",
  deny: "deny"
});

function effectFor(policy, action) {
  const decision = policy && policy[action];
  return EFFECTS[decision] || "deny";
}

function buildRuntimePermissionRules({ policy, mcpServerIds = [] } = {}) {
  const rules = [
    { action: "shell", resource: "*", effect: effectFor(policy, "shell.execute") },
    { action: "shell", resource: "git push *", effect: effectFor(policy, "git.push") },
    { action: "subagent", resource: "*", effect: effectFor(policy, "shell.execute") },
    { action: "edit", resource: "*", effect: effectFor(policy, "filesystem.write") },
    { action: "read", resource: "*", effect: effectFor(policy, "filesystem.read") },
    { action: "read", resource: "*.env", effect: "deny" },
    { action: "read", resource: "*.env.*", effect: "deny" },
    { action: "read", resource: "**/.ssh/*", effect: "deny" },
    { action: "read", resource: ".ssh/*", effect: "deny" },
    { action: "read", resource: "**/.aws/*", effect: "deny" },
    { action: "read", resource: ".aws/*", effect: "deny" },
    { action: "read", resource: "**/.azure/*", effect: "deny" },
    { action: "read", resource: ".azure/*", effect: "deny" },
    { action: "read", resource: "**/.gnupg/*", effect: "deny" },
    { action: "read", resource: ".gnupg/*", effect: "deny" },
    { action: "read", resource: "**/.kube/*", effect: "deny" },
    { action: "read", resource: ".kube/*", effect: "deny" },
    { action: "read", resource: "**/.docker/*", effect: "deny" },
    { action: "read", resource: ".docker/*", effect: "deny" },
    { action: "read", resource: "*.pem", effect: "deny" },
    { action: "read", resource: "*.key", effect: "deny" },
    { action: "read", resource: "*.p12", effect: "deny" },
    { action: "read", resource: "*.pfx", effect: "deny" },
    { action: "external_directory", resource: "*", effect: "deny" },
    { action: "webfetch", resource: "*", effect: effectFor(policy, "network.request") },
    { action: "websearch", resource: "*", effect: effectFor(policy, "network.request") },
    { action: "opencode_list_mcp_resources", resource: "*", effect: effectFor(policy, "mcp.invoke") },
    { action: "opencode_read_mcp_resource", resource: "*", effect: effectFor(policy, "mcp.invoke") }
  ];
  const ids = [...new Set(mcpServerIds)].filter(id => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id));
  const allowedHosts = Array.isArray(policy && policy["network.allowedHosts"]) ? policy["network.allowedHosts"] : [];
  for (const hostname of [...new Set(allowedHosts)]) {
    if (typeof hostname === "string" && /^[a-z0-9.-]{1,253}$/i.test(hostname) && !hostname.startsWith(".") && !hostname.includes("..")) {
      rules.push({ action: "webfetch", resource: "https://" + hostname + "/*", effect: "allow" });
    }
  }
  for (const id of ids) {
    const action = id.replace(/[^a-zA-Z0-9_-]/g, "_") + "_*";
    rules.push({ action, resource: "*", effect: effectFor(policy, "mcp.invoke") });
  }
  return rules;
}

module.exports = { buildRuntimePermissionRules, effectFor };
