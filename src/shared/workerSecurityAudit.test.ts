import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { appendWorkerSecurityAudit, verifyWorkerSecurityAudit } from "./workerSecurityAudit";

const values = new Map<string, string>();
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => { values.set(key, value); },
  removeItem: (key: string) => { values.delete(key); },
  clear: () => values.clear(),
  key: (index: number) => [...values.keys()][index] ?? null,
  get length() { return values.size; },
};

describe("worker security audit chain", () => {
  beforeEach(() => {
    values.clear();
    vi.stubGlobal("localStorage", storage);
    vi.stubGlobal("crypto", webcrypto);
  });

  it("appends verifiable metadata-only decisions with linked hashes", async () => {
    const first = await appendWorkerSecurityAudit({
      permission: "bash",
      requestedDecision: "always",
      effectiveDecision: "once",
      sessionId: "session-a",
    });
    const second = await appendWorkerSecurityAudit({
      permission: "edit",
      requestedDecision: "reject",
      effectiveDecision: "reject",
      sessionId: "session-a",
    });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.hash);
    expect(await verifyWorkerSecurityAudit()).toEqual({ valid: true, records: 2 });
    expect(JSON.stringify(values)).not.toContain("command");
  });

  it("detects record modification and refuses to append to a corrupt chain", async () => {
    await appendWorkerSecurityAudit({
      permission: "bash",
      requestedDecision: "once",
      effectiveDecision: "once",
      sessionId: "session-a",
    });
    const key = "axiom.worker-security-audit.v1";
    const records = JSON.parse(values.get(key)!);
    records[0].effectiveDecision = "always";
    values.set(key, JSON.stringify(records));
    const result = await verifyWorkerSecurityAudit();
    expect(result.valid).toBe(false);
    await expect(appendWorkerSecurityAudit({
      permission: "plugin",
      requestedDecision: "once",
      effectiveDecision: "once",
      sessionId: "session-a",
    })).rejects.toThrow(/integrity failure/i);
  });

  it("fails closed when secure hashing is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(appendWorkerSecurityAudit({
      permission: "bash",
      requestedDecision: "once",
      effectiveDecision: "once",
      sessionId: "session-a",
    })).rejects.toThrow(/WebCrypto/i);
  });
});
