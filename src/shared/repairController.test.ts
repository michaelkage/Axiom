import { describe, expect, it, vi } from "vitest";
import { runBoundedRepair } from "./repairController";

const failed = { status: "failed" as const, command: "npm test", exitCode: 1, output: "Expected 2, received 1" };

describe("runBoundedRepair", () => {
  it("verifies first and stops immediately when checks pass", async () => {
    const verify = vi.fn(async () => ({ status: "passed" as const, command: "npm test", exitCode: 0 }));
    const repair = vi.fn();
    const result = await runBoundedRepair({ verify, repair });
    expect(result.status).toBe("passed");
    expect(verify).toHaveBeenCalledTimes(1);
    expect(repair).not.toHaveBeenCalled();
  });

  it("repairs a concrete failure and reruns the exact verification", async () => {
    const verify = vi.fn()
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({ status: "passed" as const, command: "npm test", exitCode: 0, output: "12 tests passed" });
    const repair = vi.fn(async () => "Updated the failing assertion.");
    const result = await runBoundedRepair({ verify, repair });
    expect(result.status).toBe("passed");
    expect(result.attempts).toHaveLength(1);
    expect(repair).toHaveBeenCalledWith(failed, 1, expect.any(AbortSignal));
    expect(result.finalEvidence.exitCode).toBe(0);
  });

  it("never repairs unverified output or a failure without an exit code", async () => {
    const repair = vi.fn();
    const unverified = await runBoundedRepair({
      verify: async () => ({ status: "unverified", command: "npm test", output: "No exit code observed." }),
      repair,
    });
    expect(unverified.status).toBe("blocked");
    const incomplete = await runBoundedRepair({
      verify: async () => ({ status: "failed", command: "npm test", output: "failed" }),
      repair,
    });
    expect(incomplete.status).toBe("blocked");
    expect(repair).not.toHaveBeenCalled();
  });

  it("stops after the configured attempt budget", async () => {
    const verify = vi.fn(async () => failed);
    const repair = vi.fn(async () => "Tried a repair.");
    const result = await runBoundedRepair({ verify, repair, maxAttempts: 2 });
    expect(result.status).toBe("failed");
    expect(result.attempts).toHaveLength(2);
    expect(verify).toHaveBeenCalledTimes(3);
  });

  it("redacts secrets from persisted verification evidence", async () => {
    const result = await runBoundedRepair({
      verify: async () => ({ ...failed, output: "authorization: Bearer secret-token-value" }),
      repair: async () => "No-op",
      maxAttempts: 0,
    });
    expect(result.finalEvidence.output).not.toContain("secret-token-value");
  });

  it("honours cancellation before running repair", async () => {
    const controller = new AbortController();
    controller.abort();
    const repair = vi.fn();
    const result = await runBoundedRepair({ signal: controller.signal, verify: async () => failed, repair });
    expect(result.status).toBe("cancelled");
    expect(repair).not.toHaveBeenCalled();
  });
});
