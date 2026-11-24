export type AuditDecision = "once" | "always" | "reject";

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

type DesktopWorkerAuditBridge = {
  append(input: { permission: string; requestedDecision: AuditDecision; effectiveDecision: AuditDecision; sessionId: string }): Promise<WorkerSecurityAuditRecord>;
  list(): Promise<{ valid: boolean; total: number; records: WorkerSecurityAuditRecord[] }>;
  verify(): Promise<{ valid: boolean; records: number; latestHash?: string; reason?: string }>;
};

function desktopAuditBridge(): DesktopWorkerAuditBridge | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { axiomDesktop?: { workerAudit?: DesktopWorkerAuditBridge } }).axiomDesktop?.workerAudit;
}

const unavailableReason = "The privileged desktop audit host is unavailable. Worker permission grants are blocked.";

export async function verifyWorkerSecurityAudit(): Promise<{ valid: boolean; records: number; reason?: string }> {
  const desktop = desktopAuditBridge();
  if (!desktop) return { valid: false, records: 0, reason: unavailableReason };
  try {
    const result = await desktop.verify();
    return { valid: result.valid, records: result.records, reason: result.reason };
  } catch (error) {
    return { valid: false, records: 0, reason: error instanceof Error ? error.message : String(error) };
  }
}

export async function appendWorkerSecurityAudit(input: {
  permission: string;
  requestedDecision: AuditDecision;
  effectiveDecision: AuditDecision;
  sessionId: string;
}): Promise<WorkerSecurityAuditRecord> {
  const desktop = desktopAuditBridge();
  if (!desktop) throw new Error(unavailableReason);
  return desktop.append(input);
}

export async function listWorkerSecurityAudit(): Promise<{ valid: boolean; total: number; records: WorkerSecurityAuditRecord[]; reason?: string }> {
  const desktop = desktopAuditBridge();
  if (!desktop) return { valid: false, total: 0, records: [], reason: unavailableReason };
  try {
    const result = await desktop.list();
    return { valid: result.valid, total: result.total, records: result.records };
  } catch (error) {
    return { valid: false, total: 0, records: [], reason: error instanceof Error ? error.message : String(error) };
  }
}
