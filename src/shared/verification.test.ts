import { describe, expect, it } from "vitest";
import { getVerificationResult, skippedChecks } from "./verification";
describe("verification", () => {
  it("marks completed test commands passed only from observed successful state", () => {
    expect(getVerificationResult({ id: "1", tool: "bash", state: { status: "completed", input: { command: "npm test" }, output: "Tests passed" } })?.status).toBe("passed");
  });
  it("marks failed tool results failed", () => {
    expect(getVerificationResult({ id: "2", tool: "bash", state: { status: "error", input: { command: "npm run build" }, error: "exit code 1" } })?.status).toBe("failed");
  });
  it("does not invent a pass when a command is still running", () => {
    expect(getVerificationResult({ id: "3", tool: "bash", state: { status: "running", input: { command: "npm test" } } })).toBeNull();
  });
  it("makes unobserved planned checks explicitly skipped", () => {
    expect(skippedChecks(["Tests"], []).at(0)?.status).toBe("skipped");
  });
});
