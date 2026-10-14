import { describe, expect, it } from "vitest";
import { classifyRecovery } from "./recovery";
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
});
