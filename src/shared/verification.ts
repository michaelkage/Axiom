export type VerificationStatus = "passed" | "failed" | "skipped";
export interface VerificationResult {
  id: string;
  label: string;
  command: string;
  status: VerificationStatus;
  detail: string;
}
const CHECK_COMMAND = /\b(test|vitest|jest|playwright|eslint|tsc|typecheck|lint|build|check|pytest|cargo test|go test)\b/i;
type ToolStateLike = {
  status?: string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
  title?: string;
  metadata?: Record<string, unknown>;
};
export function getVerificationResult(tool: { id: string; tool?: string; state?: ToolStateLike }): VerificationResult | null {
  const state = tool.state;
  if (!state || !/bash|shell|terminal|command/i.test(tool.tool ?? "")) return null;
  const command = String(state.input?.command ?? state.input?.cmd ?? state.title ?? "");
  if (!CHECK_COMMAND.test(command)) return null;
  const label = labelFor(command);
  if (state.status === "error" || state.error) {
    return { id: tool.id, label, command, status: "failed", detail: state.error || state.output || "The tool reported an error." };
  }
  if (state.status !== "completed") return null;

  // OpenCode's tool status means the tool call finished, not necessarily that
  // the shell command exited successfully. Only an observed exit code proves pass/fail.
  const metadata = state.metadata ?? {};
  const exitValue = metadata.exitCode ?? metadata.exit_code ?? metadata.exit;
  const exitCode = typeof exitValue === "number" ? exitValue
    : typeof exitValue === "string" && /^-?\d+$/.test(exitValue) ? Number(exitValue)
    : undefined;
  const output = state.output?.trim() ?? "";
  if (exitCode !== undefined) {
    return {
      id: tool.id, label, command,
      status: exitCode === 0 ? "passed" : "failed",
      detail: output || (exitCode === 0 ? "Command exited with code 0." : `Command exited with code ${exitCode}.`),
    };
  }
  return {
    id: tool.id, label, command, status: "skipped",
    detail: output
      ? "The tool finished, but did not provide an exit code. Output alone is not treated as proof that the check passed."
      : "The tool finished without an observable exit code or output; this check could not be verified.",
  };
}
function labelFor(command: string): string {
  if (/test|vitest|jest|playwright|pytest|cargo test|go test/i.test(command)) return "Tests";
  if (/eslint|lint/i.test(command)) return "Lint";
  if (/tsc|typecheck/i.test(command)) return "Type check";
  if (/build/i.test(command)) return "Build";
  return "Verification";
}
export function skippedChecks(planned: string[], observed: VerificationResult[]): VerificationResult[] {
  const completedLabels = new Set(observed.filter(result => result.status !== "skipped").map(result => result.label.toLowerCase()));
  return planned.filter(label => !completedLabels.has(label.toLowerCase())).map(label => ({
    id: `skipped-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    label, command: "", status: "skipped", detail: "No verified exit status was observed for this check."
  }));
}
