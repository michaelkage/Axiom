export type SecurityAction = "filesystem.read" | "filesystem.write" | "shell.execute" | "network.request" | "mcp.invoke" | "git.push" | "deployment.publish" | "credential.read";
export type SecurityDecision = "allow" | "deny" | "approval-required";
export interface SecurityPolicy {
  version: 1;
  projectId: string;
  defaultDecision: "deny" | "approval-required";
  filesystem: { readRoots: string[]; writeRoots: string[]; deniedPaths: string[] };
  shell: { enabled: boolean; allowedExecutables: string[]; deniedExecutables: string[] };
  network: { enabled: boolean; allowedHosts: string[]; deniedHosts: string[]; allowHttpLocalhost: boolean };
  mcp: { enabled: boolean; allowedServers: string[]; allowedTools: string[] };
  git: { allowPush: boolean; requirePushApproval: boolean };
  deployment: { allowPublish: boolean; requirePublishApproval: boolean };
  credentials: { allowSecretMaterialToWorkers: boolean };
}
export interface SecurityRequest {
  action: SecurityAction;
  resource?: string;
  host?: string;
  executable?: string;
  serverId?: string;
  toolName?: string;
  userApproved?: boolean;
}
export interface SecurityEvaluation {
  decision: SecurityDecision;
  action: SecurityAction;
  reason: string;
  policyVersion: 1;
  projectId: string;
}
const defaultDeny = (policy: SecurityPolicy, action: SecurityAction, reason: string): SecurityEvaluation =>
  ({ decision: "deny", action, reason, policyVersion: 1, projectId: policy.projectId });
function normalizeRelativePath(value: string): string | null {
  if (!value || value.length > 1024 || value.includes("\0") || value.startsWith("/") || /^[a-z]:/i.test(value)) return null;
  const path = value.replace(/\\/g, "/");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === "..")) return null;
  return parts.join("/").toLocaleLowerCase("en-US");
}
function underRoot(target: string, root: string): boolean {
  const normalizedRoot = normalizeRelativePath(root);
  return normalizedRoot !== null && (target === normalizedRoot || target.startsWith(normalizedRoot + "/"));
}
function normalizeHost(value: string): string | null {
  try {
    const url = new URL(value.includes("://") ? value : "https://" + value);
    if (url.username || url.password) return null;
    return url.hostname.toLowerCase();
  } catch { return null; }
}
function hostMatches(host: string, rule: string): boolean {
  const normalized = normalizeHost(rule);
  return !!normalized && (host === normalized || host.endsWith("." + normalized));
}
function approval(policy: SecurityPolicy, request: SecurityRequest, reason: string): SecurityEvaluation {
  return { decision: request.userApproved ? "allow" : "approval-required", action: request.action, reason, policyVersion: 1, projectId: policy.projectId };
}

/** Evaluate every privileged action against the project's explicit policy. Missing policy grants nothing. */
export function evaluateSecurityRequest(policy: SecurityPolicy | null | undefined, request: SecurityRequest): SecurityEvaluation {
  if (!policy || policy.version !== 1 || !policy.projectId) {
    return { decision: "deny", action: request.action, reason: "No valid project security policy is loaded.", policyVersion: 1, projectId: "unknown" };
  }
  if (request.action === "filesystem.read" || request.action === "filesystem.write") {
    const target = typeof request.resource === "string" ? normalizeRelativePath(request.resource) : null;
    if (!target) return defaultDeny(policy, request.action, "Filesystem target is not a safe workspace-relative path.");
    if (policy.filesystem.deniedPaths.some(path => underRoot(target, path))) return defaultDeny(policy, request.action, "Filesystem target matches an explicitly denied path.");
    const roots = request.action === "filesystem.read" ? policy.filesystem.readRoots : policy.filesystem.writeRoots;
    if (!roots.some(root => underRoot(target, root))) return defaultDeny(policy, request.action, "Filesystem target is outside the permitted project roots.");
    return { decision: "allow", action: request.action, reason: "Filesystem target is within an explicitly permitted project root.", policyVersion: 1, projectId: policy.projectId };
  }
  if (request.action === "shell.execute") {
    const executable = request.executable?.trim().toLowerCase();
    if (!policy.shell.enabled || !executable || executable.includes("/") || executable.includes("\\") || executable.includes(";")) return defaultDeny(policy, request.action, "Shell execution is disabled or the executable identifier is invalid.");
    if (policy.shell.deniedExecutables.includes(executable)) return defaultDeny(policy, request.action, "Executable is explicitly denied.");
    if (!policy.shell.allowedExecutables.includes(executable)) return defaultDeny(policy, request.action, "Executable is not on the project allowlist.");
    return approval(policy, request, "Shell execution is allowlisted but requires user approval.");
  }
  if (request.action === "network.request") {
    if (!policy.network.enabled || !request.host) return defaultDeny(policy, request.action, "Network access is disabled or no destination was supplied.");
    const host = normalizeHost(request.host);
    if (!host) return defaultDeny(policy, request.action, "Network destination is malformed or contains credentials.");
    try {
      const destination = new URL(request.host.includes("://") ? request.host : "https://" + request.host);
      const local = destination.hostname === "localhost" || destination.hostname === "127.0.0.1" || destination.hostname === "::1";
      if (destination.protocol !== "https:" && !(local && policy.network.allowHttpLocalhost)) {
        return defaultDeny(policy, request.action, "Non-HTTPS network destinations are denied.");
      }
    } catch { return defaultDeny(policy, request.action, "Network destination is malformed."); }
    if (host === "localhost" || host === "127.0.0.1" || host === "::1") {
      if (!policy.network.allowHttpLocalhost) return defaultDeny(policy, request.action, "Localhost network access is not permitted.");
      return { decision: "allow", action: request.action, reason: "Localhost access is explicitly permitted.", policyVersion: 1, projectId: policy.projectId };
    }
    if (policy.network.deniedHosts.some(rule => hostMatches(host, rule))) return defaultDeny(policy, request.action, "Network destination matches a denied host.");
    if (!policy.network.allowedHosts.some(rule => hostMatches(host, rule))) return defaultDeny(policy, request.action, "Network destination is not allowlisted.");
    return { decision: "allow", action: request.action, reason: "Network destination is allowlisted.", policyVersion: 1, projectId: policy.projectId };
  }
  if (request.action === "mcp.invoke") {
    if (!policy.mcp.enabled || !request.serverId || !request.toolName ||
        !policy.mcp.allowedServers.includes(request.serverId) || !policy.mcp.allowedTools.includes(request.toolName)) {
      return defaultDeny(policy, request.action, "MCP server or tool is not explicitly allowlisted.");
    }
    return approval(policy, request, "MCP tool is allowlisted and requires user approval.");
  }
  if (request.action === "git.push") {
    if (!policy.git.allowPush) return defaultDeny(policy, request.action, "Git push is disabled by project policy.");
    return policy.git.requirePushApproval ? approval(policy, request, "Git push requires explicit approval.") :
      { decision: "allow", action: request.action, reason: "Git push is enabled by project policy.", policyVersion: 1, projectId: policy.projectId };
  }
  if (request.action === "deployment.publish") {
    if (!policy.deployment.allowPublish) return defaultDeny(policy, request.action, "Deployment publishing is disabled by project policy.");
    return policy.deployment.requirePublishApproval ? approval(policy, request, "Deployment publishing requires explicit approval.") :
      { decision: "allow", action: request.action, reason: "Deployment publishing is enabled by project policy.", policyVersion: 1, projectId: policy.projectId };
  }
  if (request.action === "credential.read") {
    if (!policy.credentials.allowSecretMaterialToWorkers) return defaultDeny(policy, request.action, "Secrets are never exposed to workers under the current policy.");
    return approval(policy, request, "Secret material access requires explicit user approval.");
  }
  return defaultDeny(policy, request.action, "Action is not recognized by this policy version.");
}

export type PermissionDecision = "once" | "always" | "reject";

const PRIVILEGED_PERMISSION_TYPES = new Set([
  "bash",
  "edit",
  "external_directory",
  "task",
  "webfetch",
  "websearch",
  "mcp",
  "plugin",
]);

/**
 * Prevent persistent grants for worker permissions that can execute commands,
 * mutate files, expand filesystem scope, delegate agents, or reach external
 * destinations. This is an additional runtime guard; it does not replace the
 * project-scoped SecurityPolicy evaluator above.
 */
export function resolvePermissionDecision(
  permission: string,
  requested: PermissionDecision,
): PermissionDecision {
  if (requested === "always" && PRIVILEGED_PERMISSION_TYPES.has(permission)) return "once";
  return requested;
}
