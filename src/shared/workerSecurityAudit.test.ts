import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendWorkerSecurityAudit,
  listWorkerSecurityAudit,
  verifyWorkerSecurityAudit,
  type WorkerSecurityAuditRecord,
} from "./workerSecurityAudit";

const record: WorkerSecurityAuditRecord = {
  sequence: 1,
  timestamp: "2026-11-24T00:00:00.000Z",
  permission: "bash",
  requestedDecision: "always",
  effectiveDecision: "once",
  sessionId: "session-a",
  previousHash: "0".repeat(64),
  hash: "a".repeat(64),
};

describe("worker security audit bridge", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails closed when the privileged desktop audit host is unavailable", async () => {
    await expect(appendWorkerSecurityAudit({
      permission: "bash",
      requestedDecision: "once",
      effectiveDecision: "once",
      sessionId: "session-a",
    })).rejects.toThrow(/desktop audit host is unavailable/i);
    expect(await verifyWorkerSecurityAudit()).toMatchObject({ valid: false, records: 0 });
    expect(await listWorkerSecurityAudit()).toMatchObject({ valid: false, total: 0, records: [] });
  });

  it("routes append, list, and verify through the privileged host bridge", async () => {
    const append = vi.fn(async () => record);
    const list = vi.fn(async () => ({ valid: true, total: 1, records: [record] }));
    const verify = vi.fn(async () => ({ valid: true, records: 1, latestHash: record.hash }));
    vi.stubGlobal("window", { axiomDesktop: { workerAudit: { append, list, verify } } });

    await expect(appendWorkerSecurityAudit({
      permission: "bash",
      requestedDecision: "always",
      effectiveDecision: "once",
      sessionId: "session-a",
    })).resolves.toEqual(record);
    await expect(listWorkerSecurityAudit()).resolves.toMatchObject({ valid: true, total: 1, records: [record] });
    await expect(verifyWorkerSecurityAudit()).resolves.toMatchObject({ valid: true, records: 1 });
    expect(append).toHaveBeenCalledWith({
      permission: "bash",
      requestedDecision: "always",
      effectiveDecision: "once",
      sessionId: "session-a",
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("surfaces host integrity failures without falling back to renderer storage", async () => {
    vi.stubGlobal("window", {
      axiomDesktop: {
        workerAudit: {
          append: vi.fn(),
          list: vi.fn(async () => ({ valid: false, total: 0, records: [] })),
          verify: vi.fn(async () => ({ valid: false, records: 0, reason: "HMAC mismatch" })),
        },
      },
    });
    expect(await verifyWorkerSecurityAudit()).toMatchObject({ valid: false, reason: "HMAC mismatch" });
    expect(await listWorkerSecurityAudit()).toMatchObject({ valid: false, total: 0 });
  });
});
