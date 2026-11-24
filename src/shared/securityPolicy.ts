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
 * Persistent grants are intentionally unavailable for operations that can
 * execute commands, mutate files, expand filesystem scope, delegate agents,
 * or send data to external destinations. Each such action needs a fresh
 * user decision.
 */
export function resolvePermissionDecision(
  permission: string,
  requested: PermissionDecision,
): PermissionDecision {
  if (requested === "always" && PRIVILEGED_PERMISSION_TYPES.has(permission)) return "once";
  return requested;
}
