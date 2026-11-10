import { createSignal, onCleanup, onMount, For, Show } from "solid-js";

type RemoteJob = {
  id: string; mode: string; branch: string; workspacePath: string; status: string;
  paths?: string[]; commitSha?: string | null; remoteCommitConfirmed?: boolean;
  verificationPassed?: boolean; pushSucceeded?: boolean;
  interruptedOperation?: { kind: string; startedAt: number | null } | null; operation?: { kind: string; startedAt: number } | null; error?: string | null; lastActivityAt?: number | null;
};
type ReconcileResult = {
  id: string; state: string; reason?: string; localSha?: string; remoteSha?: string;
  status?: string; remoteCommitConfirmed?: boolean; pushAllowed?: boolean;
};
type RemoteWorkspaceApi = {
  list: () => Promise<RemoteJob[]>;
  reconcile: (id: string) => Promise<ReconcileResult>;
  pushRecovered: (request: { id: string }) => Promise<{ state: string; commitSha: string }>;
  cleanup: (id: string) => Promise<{ cleaned: boolean; commitSha: string }>;
  cancel: (id: string) => Promise<boolean>;
  retryClone: (id: string) => Promise<{ id: string; status: string }>;
};
declare global {
  interface Window { axiomDesktop?: { remoteWorkspace?: RemoteWorkspaceApi } }
}

export function RemoteWorkspaceRecoveryPanel() {
  const [jobs, setJobs] = createSignal<RemoteJob[]>([]);
  const [results, setResults] = createSignal<Record<string, ReconcileResult>>({});
  const [busy, setBusy] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal("");
  const api = () => window.axiomDesktop?.remoteWorkspace;

  const refresh = async () => {
    if (!api()) return;
    try { setJobs(await api()!.list()); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not load remote workspaces."); }
  };
  onMount(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 2000);
    onCleanup(() => window.clearInterval(timer));
  });

  const reconcile = async (id: string) => {
    if (!api()) return;
    setBusy(id); setNotice("");
    try {
      const result = await api()!.reconcile(id);
      setResults(previous => ({ ...previous, [id]: result }));
      await refresh();
      setNotice(result.reason || ("Recovery check: " + result.state));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Recovery check failed.");
    } finally { setBusy(null); }
  };

  const cancel = async (job: RemoteJob) => {
    if (!api()) return;
    try {
      const requested = await api()!.cancel(job.id);
      setNotice(requested
        ? "Cancellation requested. Axiom will stop at the next safe Git operation boundary."
        : "No cancellable operation is currently running for this workspace.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not cancel this operation.");
    }
  };

  const retryClone = async (job: RemoteJob) => {
    if (job.mode === "persistent" || job.status !== "clone-interrupted" || !api()) return;
    setBusy(job.id); setNotice("");
    try {
      await api()!.retryClone(job.id);
      setNotice("Retrying the interrupted temporary clone…");
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not retry the interrupted clone.");
      await refresh();
    } finally { setBusy(null); }
  };

  const cleanup = async (job: RemoteJob) => {
    if (job.mode === "persistent" || !job.remoteCommitConfirmed || !job.verificationPassed || !job.pushSucceeded) return;
    const confirmed = window.confirm(
      "Delete this Axiom-owned temporary checkout? Its pushed commit is already confirmed on the remote branch. User-owned persistent workspaces are never deleted."
    );
    if (!confirmed || !api()) return;
    setBusy(job.id); setNotice("");
    try {
      const result = await api()!.cleanup(job.id);
      setNotice("Temporary workspace cleaned. Confirmed commit: " + result.commitSha);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Cleanup failed; workspace metadata was retained.");
      await refresh();
    } finally { setBusy(null); }
  };

  const pushRecovered = async (job: RemoteJob) => {
    const result = results()[job.id];
    if (!result || result.state !== "local-commit-pending-push") return;
    const confirmed = window.confirm(
      "Axiom will run Git's whitespace/error check (git diff --check), then push this existing commit only if the local checkout and remote branch remain unchanged. This does not run the project's test suite. No new commit will be created. Continue?"
    );
    if (!confirmed || !api()) return;
    setBusy(job.id); setNotice("");
    try {
      const pushed = await api()!.pushRecovered({ id: job.id });
      setNotice("Recovered commit pushed and remotely confirmed: " + pushed.commitSha);
      setResults(previous => ({ ...previous, [job.id]: { ...result, state: pushed.state, localSha: pushed.commitSha, remoteSha: pushed.commitSha } }));
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Recovered push failed; workspace retained.");
      await reconcile(job.id);
    } finally { setBusy(null); }
  };

  return (
    <section class="workflow-plan workflow-plan--combos" aria-label="Remote workspace recovery">
      <div class="workflow-plan__eyebrow">REMOTE WORKSPACES <span>RECOVERY & PUSH SAFETY</span></div>
      <Show when={notice()}><p role="status" class="text-sm">{notice()}</p></Show>
      <Show when={jobs().length > 0} fallback={<p class="text-sm text-muted">No remote workspace jobs are currently saved.</p>}>
        <div class="flex flex-col gap-3">
          <For each={jobs()}>{job => {
            const result = () => results()[job.id];
            return (
              <article class="rounded-lg border border-[var(--border)] p-3">
                <div class="flex flex-wrap items-center justify-between gap-2">
                  <div class="min-w-0">
                    <div class="font-medium">{job.branch} <span class="text-xs text-muted">· {job.mode}</span></div>
                    <div class="truncate text-xs text-muted" title={job.workspacePath}>{job.workspacePath}</div>
                  </div>
                  <span class="text-xs">{result()?.state || job.status}</span>
                </div>
                <Show when={result()?.reason}><p class="mt-2 text-sm text-muted">{result()!.reason}</p></Show>
                <Show when={job.error}>
                  <p class="mt-2 text-sm text-amber-500">{job.error}</p>
                </Show>
                <Show when={job.status === "creating" && job.operation?.kind === "clone"}>
                  <p class="mt-2 text-sm text-muted">Cloning repository… this operation can be cancelled safely.</p>
                </Show>
                <Show when={job.status === "clone-interrupted"}>
                  <p class="mt-2 text-sm text-amber-500">Clone was interrupted. Temporary partial checkouts are removed on recovery; persistent destinations are preserved.</p>
                </Show>
                <Show when={job.interruptedOperation}>
                  <p class="mt-2 text-sm text-amber-500">
                    Previous {job.interruptedOperation!.kind} operation was interrupted when Axiom closed. Check recovery before retrying.
                  </p>
                </Show>
                <Show when={result()?.localSha}>
                  <div class="mt-2 grid gap-1 text-xs text-muted">
                    <div>Local: <code>{result()!.localSha}</code></div>
                    <div>Remote: <code>{result()!.remoteSha || "unavailable"}</code></div>
                  </div>
                </Show>
                <div class="mt-3 flex flex-wrap gap-2">
                  <Show when={job.mode !== "persistent" && job.status === "clone-interrupted"}>
                    <button class="workflow-plan__secondary" disabled={busy() === job.id || !!job.operation} onClick={() => void retryClone(job)}>
                      Retry clone
                    </button>
                  </Show>
                  <Show when={busy() === job.id || !!job.operation}>
                    <button class="workflow-plan__secondary" onClick={() => void cancel(job)}>
                      Cancel {job.operation?.kind || "operation"}
                    </button>
                  </Show>
                  <button class="workflow-plan__secondary" disabled={busy() === job.id} onClick={() => void reconcile(job.id)}>
                    {busy() === job.id ? "Checking…" : "Check recovery"}
                  </button>
                  <Show when={job.mode !== "persistent" && job.remoteCommitConfirmed && job.verificationPassed && job.pushSucceeded && job.status !== "cleaned"}>
                    <button class="workflow-plan__secondary" disabled={busy() === job.id} onClick={() => void cleanup(job)}>
                      {busy() === job.id ? "Cleaning…" : "Clean temporary workspace"}
                    </button>
                  </Show>
                  <Show when={result()?.state === "local-commit-pending-push"}>
                    <button class="workflow-plan__secondary" disabled={busy() === job.id} onClick={() => void pushRecovered(job)}>
                      Check diff & push existing commit
                    </button>
                  </Show>
                </div>
              </article>
            );
          }}</For>
        </div>
      </Show>
      <Show when={api()}><button class="workflow-plan__secondary mt-3" onClick={() => void refresh()}>Refresh workspaces</button></Show>
    </section>
  );
}
