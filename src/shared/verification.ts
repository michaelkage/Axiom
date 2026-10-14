export type VerificationStatus = "passed" | "failed" | "skipped";
export interface VerificationResult {
  id: string;
  label: string;
  command: string;
  status: VerificationStatus;
  detail: string;
}
const CHECK_COMMAND = /\b(test|vitest|jest|playwright|eslint|tsc|typecheck|lint|build|check|pytest|cargo test|go test)\b/i;
export function getVerificationResult(tool: { id: string; tool?: string; state?: { status?: string; input?: Record<string, unknown>; output?: string; error?: string; title?: string } }): VerificationResult | null {
  const state = tool.state;
  if (!state || !/bash|shell|terminal|command/i.test(tool.tool ?? "")) return null;
  const command = String(state.input?.command ?? state.input?.cmd ?? state.title ?? "");
  if (!CHECK_COMMAND.test(command)) return null;
  if (state.status === "error" || state.error) return { id: tool.id, label: labelFor(command), command, status: "failed", detail: state.error || state.output || "The command reported an error." };
  if (state.status === "completed") {
    const output = state.output ?? "";
    const failed = /\b(error|failed|failure|✖|\bFAIL\b|exit code [1-9]\d*)\b/i.test(output);
    return { id: tool.id, label: labelFor(command), command, status: failed ? "failed" : "passed", detail: output.trim() || (failed ? "Command output indicates failure." : "Command completed successfully.") };
  }
  return null;
}
function labelFor(command: string): string {
  if (/test|vitest|jest|playwright|pytest|cargo test|go test/i.test(command)) return "Tests";
  if (/eslint|lint/i.test(command)) return "Lint";
  if (/tsc|typecheck/i.test(command)) return "Type check";
  if (/build/i.test(command)) return "Build";
  return "Verification";
}
export function skippedChecks(planned: string[], observed: VerificationResult[]): VerificationResult[] {
  const completedLabels = new Set(observed.map(result => result.label.toLowerCase()));
  return planned.filter(label => !completedLabels.has(label.toLowerCase())).map(label => ({
    id: `skipped-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    label, command: "", status: "skipped", detail: "No completed command result was observed for this check."
  }));
}
