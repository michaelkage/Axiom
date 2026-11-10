import { describe, expect, it } from "vitest";
import { getVerificationResult, skippedChecks } from "./verification";

describe("verification", () => {
  it("marks a check passed only when the completed tool exposes exit code zero", () => {
    expect(getVerificationResult({
      id: "1", tool: "bash",
      state: { status: "completed", input: { command: "npm test" }, output: "Tests passed", metadata: { exitCode: 0 } },
    })?.status).toBe("passed");
  });
  it("marks non-zero exit codes failed even when the tool call completed", () => {
    expect(getVerificationResult({
      id: "2", tool: "bash",
      state: { status: "completed", input: { command: "npm run build" }, output: "Build failed", metadata: { exit: 1 } },
    })?.status).toBe("failed");
  });
  it("marks tool errors as failed", () => {
    expect(getVerificationResult({
      id: "3", tool: "bash",
      state: { status: "error", input: { command: "npm run build" }, error: "exit code 1" },
    })?.status).toBe("failed");
  });
  it("does not infer success from output without an exit code", () => {
    expect(getVerificationResult({
      id: "4", tool: "bash",
      state: { status: "completed", input: { command: "npm test" }, output: "Tests passed" },
    })?.status).toBe("skipped");
  });
  it("does not classify a running command as a result", () => {
    expect(getVerificationResult({
      id: "5", tool: "bash", state: { status: "running", input: { command: "npm test" } },
    })).toBeNull();
  });
  it("marks unverified planned checks skipped", () => {
    expect(skippedChecks(["Tests"], [])[0]?.status).toBe("skipped");
  });
});
