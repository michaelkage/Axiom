import { classifyRecovery, redactDiagnostic } from "./recovery";

export type RepairCheckStatus = "passed" | "failed" | "unverified";
export interface RepairCheckEvidence {
  status: RepairCheckStatus;
  command?: string;
  exitCode?: number;
  output?: string;
  label?: string;
}
export interface RepairAttemptRecord {
  attempt: number;
  startedAt: number;
  finishedAt: number;
  failure: RepairCheckEvidence;
  repairSummary: string;
  verification: RepairCheckEvidence;
}
export interface RepairControllerResult {
  status: "passed" | "blocked" | "failed" | "cancelled" | "timed_out";
  attempts: RepairAttemptRecord[];
  finalEvidence: RepairCheckEvidence;
  reason: string;
}
export interface RepairControllerOptions {
  verify: (signal: AbortSignal) => Promise<RepairCheckEvidence>;
  repair: (failure: RepairCheckEvidence, attempt: number, signal: AbortSignal) => Promise<string>;
  maxAttempts?: number;
  maxDurationMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  onAttempt?: (record: RepairAttemptRecord) => void;
}

const MAX_ATTEMPTS = 5;
const DEFAULT_ATTEMPTS = 2;
const DEFAULT_DURATION_MS = 10 * 60 * 1000;

function normalizeEvidence(value: RepairCheckEvidence): RepairCheckEvidence {
  if (!value || typeof value !== "object" || !["passed", "failed", "unverified"].includes(value.status)) {
    return { status: "unverified", output: "Verifier returned an invalid evidence record." };
  }
  return {
    status: value.status,
    ...(typeof value.command === "string" ? { command: value.command.slice(0, 1000) } : {}),
    ...(Number.isInteger(value.exitCode) ? { exitCode: value.exitCode } : {}),
    ...(typeof value.output === "string" ? { output: redactDiagnostic(value.output).slice(-12_000) } : {}),
    ...(typeof value.label === "string" ? { label: value.label.slice(0, 120) } : {}),
  };
}

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Runs a bounded verify → repair → verify loop.
 * Repairs are only attempted when a concrete failed check and command are available.
 * A model's explanation can never turn a failed or unverified check into a pass.
 */
export async function runBoundedRepair(options: RepairControllerOptions): Promise<RepairControllerResult> {
  if (typeof options.verify !== "function" || typeof options.repair !== "function") {
    throw new TypeError("Repair controller requires verification and repair callbacks.");
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_ATTEMPTS;
  const maxDurationMs = options.maxDurationMs ?? DEFAULT_DURATION_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 0 || maxAttempts > MAX_ATTEMPTS) {
    throw new RangeError("Repair attempts must be an integer between 0 and " + MAX_ATTEMPTS + ".");
  }
  if (!Number.isFinite(maxDurationMs) || maxDurationMs < 1 || maxDurationMs > 60 * 60 * 1000) {
    throw new RangeError("Repair duration must be between 1ms and one hour.");
  }

  const now = options.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const parentAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", parentAbort, { once: true });
  if (options.signal?.aborted) parentAbort();
  const attempts: RepairAttemptRecord[] = [];
  const expired = () => now() - startedAt >= maxDurationMs;
  const finish = (status: RepairControllerResult["status"], evidence: RepairCheckEvidence, reason: string): RepairControllerResult => ({
    status, attempts, finalEvidence: normalizeEvidence(evidence), reason,
  });

  try {
    if (aborted(controller.signal)) return finish("cancelled", { status: "unverified", output: "Cancelled before verification." }, "Repair was cancelled.");
    if (expired()) return finish("timed_out", { status: "unverified", output: "Repair time budget expired before verification." }, "Repair time budget exhausted.");

    let evidence = normalizeEvidence(await options.verify(controller.signal));
    if (evidence.status === "passed") return finish("passed", evidence, "The required verification passed.");
    if (evidence.status === "unverified") return finish("blocked", evidence, "Verification did not provide trustworthy failure evidence; automatic repair was not attempted.");
    if (!evidence.command || evidence.exitCode === undefined || evidence.exitCode === 0) {
      return finish("blocked", evidence, "A concrete failing command and non-zero exit code are required before automatic repair.");
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (aborted(controller.signal)) return finish("cancelled", evidence, "Repair was cancelled.");
      if (expired()) return finish("timed_out", evidence, "Repair time budget exhausted.");
      const attemptStartedAt = now();
      let repairSummary: string;
      try {
        repairSummary = redactDiagnostic(await options.repair(evidence, attempt, controller.signal)).slice(0, 4000);
      } catch (error) {
        const advice = classifyRecovery(error);
        const failure = normalizeEvidence({
          status: "failed",
          command: evidence.command,
          exitCode: evidence.exitCode,
          output: advice.title + ": " + advice.explanation + "\n" + redactDiagnostic(error),
          label: evidence.label,
        });
        const record: RepairAttemptRecord = {
          attempt, startedAt: attemptStartedAt, finishedAt: now(),
          failure: evidence, repairSummary: "Repair worker failed: " + redactDiagnostic(error).slice(0, 1000),
          verification: failure,
        };
        attempts.push(record);
        try { options.onAttempt?.(record); } catch { /* observers cannot interrupt recovery */ }
        evidence = failure;
        if (!advice.safeToRetryAutomatically || attempt === maxAttempts) {
          return finish("failed", evidence, "Repair worker failed and the error is not safe for another automatic attempt.");
        }
        continue;
      }

      if (aborted(controller.signal)) return finish("cancelled", evidence, "Repair was cancelled after the repair worker returned.");
      if (expired()) return finish("timed_out", evidence, "Repair time budget exhausted after the repair worker returned.");
      const verified = normalizeEvidence(await options.verify(controller.signal));
      const record: RepairAttemptRecord = {
        attempt, startedAt: attemptStartedAt, finishedAt: now(),
        failure: evidence, repairSummary, verification: verified,
      };
      attempts.push(record);
      try { options.onAttempt?.(record); } catch { /* observers cannot interrupt recovery */ }
      evidence = verified;
      if (verified.status === "passed") return finish("passed", evidence, "Verification passed after repair attempt " + attempt + ".");
      if (verified.status === "unverified") return finish("blocked", evidence, "Verification became unverified; automatic repair stopped.");
      if (!verified.command || verified.exitCode === undefined || verified.exitCode === 0) {
        return finish("blocked", evidence, "The latest failure does not contain a concrete failing command and exit code.");
      }
    }
    return finish("failed", evidence, "The configured repair-attempt limit was reached.");
  } catch (error) {
    if (controller.signal.aborted) return finish("cancelled", { status: "unverified", output: redactDiagnostic(error) }, "Repair was cancelled.");
    if (expired()) return finish("timed_out", { status: "unverified", output: redactDiagnostic(error) }, "Repair time budget exhausted.");
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", parentAbort);
  }
}
