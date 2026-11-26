import { For, Show, createSignal, onMount } from "solid-js";
import { listWorkerSecurityAudit, verifyWorkerSecurityAudit, type WorkerSecurityAuditRecord } from "../../shared/workerSecurityAudit";

export function WorkerSecurityAuditPanel() {
  const [records, setRecords] = createSignal<WorkerSecurityAuditRecord[]>([]);
  const [total, setTotal] = createSignal(0);
  const [valid, setValid] = createSignal<boolean | null>(null);
  const [error, setError] = createSignal("");
  const [busy, setBusy] = createSignal(false);

  const refresh = async () => {
    if (busy()) return;
    setBusy(true);
    setError("");
    try {
      const [listing, verification] = await Promise.all([
        listWorkerSecurityAudit(),
        verifyWorkerSecurityAudit()
      ]);
      setRecords(listing.records);
      setTotal(listing.total);
      setValid(listing.valid && verification.valid);
      if (!listing.valid || !verification.valid) setError(listing.reason || verification.reason || "Audit integrity verification failed.");
    } catch (cause) {
      setValid(false);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  onMount(() => { void refresh(); });

  return (
    <section class="workflow-plan workflow-plan--security-audit" aria-label="Worker security audit">
      <div class="workflow-plan__eyebrow">SECURITY <span>TAMPER-EVIDENT WORKER AUDIT</span></div>
      <div class="workflow-plan__actions">
        <h2>Worker permission history</h2>
        <button type="button" class="workflow-plan__secondary" onClick={() => void refresh()} disabled={busy()}>
          {busy() ? "Verifying…" : "Refresh and verify"}
        </button>
      </div>
      <p class="workflow-plan__prompt">Permission decisions are stored by the desktop host and authenticated with an OS-protected signing key. This view excludes command text, file contents, and credentials.</p>
      <div class="workflow-plan__actions" role="status">
        <span>{total()} recorded decisions</span>
        <span>{valid() === null ? "Verification pending" : valid() ? "Integrity verified" : "Integrity failure"}</span>
      </div>
      <Show when={error()}>
        <p role="alert" class="text-sm text-red-300">{error()}</p>
      </Show>
      <Show when={records().length > 0} fallback={<p class="text-sm text-slate-500">No worker permission decisions have been recorded yet.</p>}>
        <ol class="workflow-plan__audit-records">
          <For each={records()}>
            {(record) => (
              <li>
                <strong>{record.permission}</strong>
                <span>{record.effectiveDecision.toUpperCase()} · requested {record.requestedDecision}</span>
                <small>{new Date(record.timestamp).toLocaleString()} · {record.sessionId} · #{record.sequence}</small>
                <small>SHA-256 HMAC: {record.hash.slice(0, 20)}…</small>
              </li>
            )}
          </For>
        </ol>
      </Show>
    </section>
  );
}
