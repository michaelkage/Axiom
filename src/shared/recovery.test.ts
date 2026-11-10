import { describe, expect, it } from "vitest";
import { classifyRecovery, redactDiagnostic } from "./recovery";

describe("classifyRecovery", () => {
  it("allows bounded retry advice for connection failures", () => {
    expect(classifyRecovery(new Error("ECONNREFUSED")).safeToRetryAutomatically).toBe(true);
  });
  it("never auto-retries permission failures", () => {
    expect(classifyRecovery(new Error("Permission denied")).safeToRetryAutomatically).toBe(false);
  });
  it("does not auto-retry potentially side-effecting tool errors", () => {
    expect(classifyRecovery("command exit code 1").kind).toBe("tool");
    expect(classifyRecovery("command exit code 1").safeToRetryAutomatically).toBe(false);
  });
  it("distinguishes authentication, model, quota, and rate-limit failures", () => {
    expect(classifyRecovery("401 invalid API key").kind).toBe("connection");
    expect(classifyRecovery("model not found").kind).toBe("local-model");
    expect(classifyRecovery("insufficient credits billing").safeToRetryAutomatically).toBe(false);
    expect(classifyRecovery("429 too many requests").safeToRetryAutomatically).toBe(true);
  });
  it("redacts common credentials before showing diagnostic messages", () => {
    const diagnostic = redactDiagnostic("api_key=sk-12345678901234567890 Authorization: Bearer abc.def https://user:pass@example.com");
    expect(diagnostic).not.toContain("sk-12345678901234567890");
    expect(diagnostic).not.toContain("Bearer abc.def");
    expect(diagnostic).not.toContain("user:pass");
    expect(diagnostic).toContain("[REDACTED]");
  });
});
