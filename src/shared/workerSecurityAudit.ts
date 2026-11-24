const STORAGE_KEY = "axiom.worker-security-audit.v1";
const GENESIS_HASH = "0".repeat(64);

type DesktopWorkerAuditBridge = {
  append(input: { permission: string; requestedDecision: AuditDecision; effectiveDecision: AuditDecision; sessionId: string }): Promise<WorkerSecurityAuditRecord>;
  list(): Promise<{ valid: boolean; total: number; records: WorkerSecurityAuditRecord[] }>;
  verify(): Promise<{ valid: boolean; records: number; latestHash?: string; reason?: string }>;
};

function desktopAuditBridge(): DesktopWorkerAuditBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { axiomDesktop?: { workerAudit?: DesktopWorkerAuditBridge } }).axiomDesktop?.workerAudit;
}

type AuditDecision = "once" | "always" | "reject";
export interface WorkerSecurityAuditRecord {
  sequence: number;
  timestamp: string;
  permission: string;
  requestedDecision: AuditDecision;
  effectiveDecision: AuditDecision;
  sessionId: string;
  previousHash: string;
  hash: string;
}

function canonical(record: Omit<WorkerSecurityAuditRecord, "hash">): string {
  return JSON.stringify({
    sequence: record.sequence,
    timestamp: record.timestamp,
    permission: record.permission,
    requestedDecision: record.requestedDecision,
    effectiveDecision: record.effectiveDecision,
    sessionId: record.sessionId,
    previousHash: record.previousHash,
  });
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error("WebCrypto is required for worker security audit integrity.");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

function readRecords(): WorkerSecurityAuditRecord[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("Worker security audit store is malformed.");
  return parsed as WorkerSecurityAuditRecord[];
}

export async function verifyWorkerSecurityAudit(): Promise<{ valid: boolean; records: number; reason?: string }> {
  try {
    const records = readRecords();
    let previousHash = GENESIS_HASH;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.sequence !== index + 1 || record.previousHash !== previousHash) {
        return { valid: false, records: records.length, reason: `Chain linkage failed at record ${index + 1}.` };
      }
      const { hash, ...payload } = record;
      if (await sha256(canonical(payload)) !== hash) {
        return { valid: false, records: records.length, reason: `Record hash mismatch at record ${index + 1}.` };
      }
      previousHash = hash;
    }
    return { valid: true, records: records.length };
  } catch (error) {
    return { valid: false, records: 0, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Appends metadata-only worker permission decisions. The chain is verified
 * before every append; storage or integrity failures are fail-closed.
 *
 * This browser-owned chain detects accidental edits and partial deletion, but
 * is not hardware-backed against an attacker who can rewrite localStorage.
 */
export async function appendWorkerSecurityAudit(input: {
  permission: string;
  requestedDecision: AuditDecision;
  effectiveDecision: AuditDecision;
  sessionId: string;
}): Promise<WorkerSecurityAuditRecord> {
  const verification = await verifyWorkerSecurityAudit();
  if (!verification.valid) throw new Error(`Worker security audit integrity failure: ${verification.reason || "unknown"}`);
  const records = readRecords();
  const previousHash = records.length ? records[records.length - 1].hash : GENESIS_HASH;
  const payload = {
    sequence: records.length + 1,
    timestamp: new Date().toISOString(),
    permission: input.permission,
    requestedDecision: input.requestedDecision,
    effectiveDecision: input.effectiveDecision,
    sessionId: input.sessionId,
    previousHash,
  };
  const record: WorkerSecurityAuditRecord = { ...payload, hash: await sha256(canonical(payload)) };
  records.push(record);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
  const persisted = await verifyWorkerSecurityAudit();
  if (!persisted.valid || persisted.records !== records.length) {
    throw new Error(`Worker security audit persistence verification failed: ${persisted.reason || "record count mismatch"}`);
  }
  return record;
}


export async function listWorkerSecurityAudit(): Promise<{ valid: boolean; total: number; records: WorkerSecurityAuditRecord[]; reason?: string }> {
  const desktop = desktopAuditBridge();
  if (desktop) {
    const result = await desktop.list();
    return { valid: result.valid, total: result.total, records: result.records };
  }
  const verification = await verifyWorkerSecurityAudit();
  if (!verification.valid) return { valid: false, total: 0, records: [], reason: verification.reason };
  const records = readRecords();
  return { valid: true, total: records.length, records: records.slice(-1000).reverse() };
}
