import { describe, expect, it } from "vitest";
import { evaluateSecurityRequest, resolvePermissionDecision, type SecurityPolicy } from "./securityPolicy";
const policy: SecurityPolicy = {
  version: 1, projectId: "project-1", defaultDecision: "deny",
  filesystem: { readRoots: ["src", "docs"], writeRoots: ["src"], deniedPaths: ["src/secrets"] },
  shell: { enabled: true, allowedExecutables: ["pnpm", "node"], deniedExecutables: ["curl"] },
  network: { enabled: true, allowedHosts: ["api.example.com"], deniedHosts: ["evil.example.com"], allowHttpLocalhost: false },
  mcp: { enabled: true, allowedServers: ["github"], allowedTools: ["issues.list"] },
  git: { allowPush: true, requirePushApproval: true },
  deployment: { allowPublish: true, requirePublishApproval: true },
  credentials: { allowSecretMaterialToWorkers: false },
};

describe("project security policy engine", () => {
  it("allows only workspace-relative filesystem paths under approved roots", () => {
    expect(evaluateSecurityRequest(policy, { action: "filesystem.write", resource: "src/app.ts" }).decision).toBe("allow");
    expect(evaluateSecurityRequest(policy, { action: "filesystem.write", resource: "../outside.ts" }).decision).toBe("deny");
    expect(evaluateSecurityRequest(policy, { action: "filesystem.write", resource: "src/secrets/token" }).reason).toMatch(/denied/);
    expect(evaluateSecurityRequest(policy, { action: "filesystem.write", resource: "docs/readme.md" }).decision).toBe("deny");
  });
  it("requires allowlisting and approval for shell and MCP actions", () => {
    expect(evaluateSecurityRequest(policy, { action: "shell.execute", executable: "pnpm" }).decision).toBe("approval-required");
    expect(evaluateSecurityRequest(policy, { action: "shell.execute", executable: "curl" }).decision).toBe("deny");
    expect(evaluateSecurityRequest(policy, { action: "mcp.invoke", serverId: "github", toolName: "issues.list", userApproved: true }).decision).toBe("allow");
    expect(evaluateSecurityRequest(policy, { action: "mcp.invoke", serverId: "github", toolName: "repo.delete" }).decision).toBe("deny");
  });
  it("restricts network destinations by host and blocks credentials in URLs", () => {
    expect(evaluateSecurityRequest(policy, { action: "network.request", host: "https://api.example.com/v1" }).decision).toBe("allow");
    expect(evaluateSecurityRequest(policy, { action: "network.request", host: "https://sub.evil.example.com" }).decision).toBe("deny");
    expect(evaluateSecurityRequest(policy, { action: "network.request", host: "https://user:pass@api.example.com" }).decision).toBe("deny");
    expect(evaluateSecurityRequest(policy, { action: "network.request", host: "http://localhost:3000" }).decision).toBe("deny");
  });
  it("requires explicit approvals for push, publishing and secret access", () => {
    expect(evaluateSecurityRequest(policy, { action: "git.push" }).decision).toBe("approval-required");
    expect(evaluateSecurityRequest(policy, { action: "git.push", userApproved: true }).decision).toBe("allow");
    expect(evaluateSecurityRequest(policy, { action: "deployment.publish" }).decision).toBe("approval-required");
    expect(evaluateSecurityRequest(policy, { action: "credential.read" }).decision).toBe("deny");
  });
  it("fails closed when policy is absent", () => {
    expect(evaluateSecurityRequest(null, { action: "filesystem.read", resource: "src/a.ts" }).decision).toBe("deny");
  });
});

describe("worker permission policy", () => {
  it.each(["bash", "edit", "external_directory", "task", "webfetch", "mcp", "plugin"])(
    "downgrades persistent grants for privileged %s operations",
    permission => {
      expect(resolvePermissionDecision(permission, "always")).toBe("once");
      expect(resolvePermissionDecision(permission, "once")).toBe("once");
      expect(resolvePermissionDecision(permission, "reject")).toBe("reject");
    },
  );

  it("preserves persistent grants for non-privileged read-only permissions", () => {
    expect(resolvePermissionDecision("read", "always")).toBe("always");
    expect(resolvePermissionDecision("glob", "always")).toBe("always");
    expect(resolvePermissionDecision("websearch", "always")).toBe("always");
  });
});
