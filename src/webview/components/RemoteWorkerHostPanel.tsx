import { createSignal, onMount, onCleanup, Show, For } from "solid-js";
import { WorktreeReviewPanel } from "./WorktreeReviewPanel";

interface RemoteWorkerJob {
  id: string; taskId: string; title: string; status: string;
  summary?: string | null; error?: string | null; patchAvailable?: boolean;
  patchError?: string | null; logs: Array<{ id: string; message: string }>;
}
interface ImportedRemoteJob { jobId: string; taskId: string; title: string; worktreePath: string }
interface RemoteWorkerSettings {
  hostUrl: string; repositoryUrl: string; branch: string;
  enabled: boolean; tokenConfigured: boolean;
}
interface RemoteWorkerBridge {
  config(): Promise<RemoteWorkerSettings>;
  test(): Promise<{ status: string; protocol: number }>;
  list(): Promise<{ jobs: RemoteWorkerJob[] }>;
  getPatch(id: string): Promise<{ patch: string; bytes: number }>;
  cancel(id: string): Promise<unknown>;
  applyPatch(request: { jobId: string; taskId: string; title: string; patch: string }): Promise<{ worktreePath: string }>;
  save(request: { hostUrl: string; repositoryUrl: string; branch: string; token: string; enabled: boolean }): Promise<RemoteWorkerSettings>;
}
function bridge(): RemoteWorkerBridge | undefined {
  return (window as unknown as { axiomDesktop?: { remoteWorker?: RemoteWorkerBridge } }).axiomDesktop?.remoteWorker;
}
export function RemoteWorkerHostPanel(props: { workspaceRoot?: string }) {
  const [hostUrl, setHostUrl] = createSignal("");
  const [repositoryUrl, setRepositoryUrl] = createSignal("");
  const [branch, setBranch] = createSignal("main");
  const [token, setToken] = createSignal("");
  const [tokenConfigured, setTokenConfigured] = createSignal(false);
  const [enabled, setEnabled] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [jobs, setJobs] = createSignal<RemoteWorkerJob[]>([]);
  const [imported, setImported] = createSignal<ImportedRemoteJob[]>([]);
  const [jobBusy, setJobBusy] = createSignal<string | null>(null);
  let jobTimer: number | undefined;

  const refreshJobs = async () => {
    const api = bridge();
    if (!api || !tokenConfigured()) return;
    try { setJobs((await api.list()).jobs ?? []); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Could not refresh remote jobs."); }
  };
  const startJobPolling = () => {
    if (jobTimer === undefined && tokenConfigured()) {
      void refreshJobs();
      jobTimer = window.setInterval(() => { void refreshJobs(); }, 5000);
    }
  };

  onMount(() => {
    void bridge()?.config().then(settings => {
      setHostUrl(settings.hostUrl || "");
      setRepositoryUrl(settings.repositoryUrl || "");
      setBranch(settings.branch || "main");
      setEnabled(settings.enabled === true);
      setTokenConfigured(settings.tokenConfigured === true);
      startJobPolling();
    }).catch(error => setNotice(error instanceof Error ? error.message : "Could not load remote worker settings."));
  });
  onCleanup(() => { if (jobTimer !== undefined) window.clearInterval(jobTimer); });

  const testConnection = async () => {
    const api = bridge();
    if (!api || busy()) return;
    setBusy(true); setNotice("");
    try {
      const result = await api.test();
      setNotice("Connected to Axiom Worker Host protocol " + result.protocol + ".");
      await refreshJobs();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Worker Host connection failed."); }
    finally { setBusy(false); }
  };

  const save = async () => {
    const api = bridge();
    if (!api || busy()) return;
    setBusy(true); setNotice("");
    try {
      const settings = await api.save({
        hostUrl: hostUrl().trim(), repositoryUrl: repositoryUrl().trim(),
        branch: branch().trim(), token: token(), enabled: enabled(),
      });
      setToken(""); setTokenConfigured(settings.tokenConfigured === true);
      setEnabled(settings.enabled === true);
      startJobPolling();
      setNotice(settings.enabled
        ? "Remote workers enabled. New parallel tasks will run on the configured Worker Host; results return to local isolated review worktrees."
        : "Worker Host settings saved. Parallel tasks will continue using the local runtime.");
      await refreshJobs();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save remote worker settings."); }
    finally { setBusy(false); }
  };

  const cancelJob = async (job: RemoteWorkerJob) => {
    const api = bridge();
    if (!api || jobBusy()) return;
    setJobBusy(job.id); setNotice("");
    try {
      await api.cancel(job.id);
      setNotice("Cancellation requested for " + job.title + ".");
      await refreshJobs();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not cancel remote job."); }
    finally { setJobBusy(null); }
  };

  const importJobPatch = async (job: RemoteWorkerJob) => {
    const api = bridge();
    if (!api || !props.workspaceRoot || jobBusy()) return;
    if (imported().some(item => item.jobId === job.id)) {
      setNotice("This remote job already has a local review worktree.");
      return;
    }
    setJobBusy(job.id); setNotice("");
    try {
      const patch = await api.getPatch(job.id);
      const local = await api.applyPatch({ jobId: job.id, taskId: job.taskId, title: job.title, patch: patch.patch });
      setImported(items => [...items, { jobId: job.id, taskId: job.taskId, title: job.title, worktreePath: local.worktreePath }]);
      setNotice("Remote changes imported into an isolated local review worktree. Review the diff and quality gate before integrating.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not import remote patch."); }
    finally { setJobBusy(null); }
  };

  return <section class="axiom-remote-worker" aria-label="Remote Worker Host settings">
    <div class="axiom-remote-worker__heading">
      <div><strong>Persistent cloud workspaces</strong><small>Run parallel worker tasks on your own Axiom Worker Host, then review changes locally</small></div>
      <span>{enabled() ? "REMOTE ENABLED" : "LOCAL EXECUTION"}</span>
    </div>
    <label>Worker Host URL
      <input value={hostUrl()} onInput={event => setHostUrl(event.currentTarget.value)} placeholder="https://worker.example.com" />
    </label>
    <label>Git repository URL
      <input value={repositoryUrl()} onInput={event => setRepositoryUrl(event.currentTarget.value)} placeholder="https://github.com/owner/repository.git" />
    </label>
    <label>Base branch
      <input value={branch()} onInput={event => setBranch(event.currentTarget.value)} placeholder="main" />
    </label>
    <label>Worker Host bearer token
      <input type="password" autocomplete="off" value={token()} onInput={event => setToken(event.currentTarget.value)} placeholder={tokenConfigured() ? "Saved securely — leave blank to keep it" : "Paste Worker Host token"} />
    </label>
    <Show when={tokenConfigured()}><small class="axiom-remote-worker__saved">A bearer token is stored in OS-backed secure storage. It is never returned to the renderer.</small></Show>
    <label class="axiom-remote-worker__toggle">
      <input type="checkbox" checked={enabled()} onChange={event => setEnabled(event.currentTarget.checked)} />
      Use the remote host for new parallel worker tasks
    </label>
    <div class="axiom-remote-worker__actions">
      <button type="button" disabled={busy() || !bridge()} onClick={() => void save()}>{busy() ? "Working…" : "Save Worker Host settings"}</button>
      <button type="button" disabled={busy() || !bridge() || !tokenConfigured()} onClick={() => void testConnection()}>Test connection</button>
    </div>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <Show when={tokenConfigured()}>
      <div class="axiom-remote-worker__jobs">
        <div class="axiom-remote-worker__jobs-heading"><strong>Remote jobs</strong><button type="button" disabled={jobBusy() !== null} onClick={() => void refreshJobs()}>Refresh</button></div>
        <Show when={jobs().length > 0} fallback={<small>No saved Worker Host jobs yet.</small>}>
          <For each={jobs()}>{job => <article>
            <div><strong>{job.title}</strong><span>{job.status}</span></div>
            <small>{job.taskId}</small>
            <Show when={job.summary}><p>{job.summary}</p></Show>
            <Show when={job.error || job.patchError}><p class="axiom-remote-worker__error">{job.error || job.patchError}</p></Show>
            <Show when={(job.logs ?? []).length > 0}><details><summary>Recent worker logs</summary><For each={job.logs}>{entry => <p>{entry.message}</p>}</For></details></Show>
            <div class="axiom-remote-worker__job-actions">
              <Show when={["queued", "provisioning", "running"].includes(job.status)}>
                <button type="button" disabled={jobBusy() === job.id} onClick={() => void cancelJob(job)}>Cancel job</button>
              </Show>
              <Show when={job.status === "succeeded" && job.patchAvailable}>
                <button type="button" disabled={jobBusy() === job.id || !props.workspaceRoot} onClick={() => void importJobPatch(job)}>{jobBusy() === job.id ? "Importing…" : "Import patch for review"}</button>
              </Show>
            </div>
          </article>}</For>
        </Show>
      </div>
    </Show>
    <For each={imported()}>{item => <div class="axiom-remote-worker__review">
      <strong>Local review · {item.title}</strong>
      <WorktreeReviewPanel taskId={item.taskId} worktreePath={item.worktreePath} workspaceRoot={props.workspaceRoot} />
    </div>}</For>
    <small>Remote execution requires a running Axiom Worker Host and Git access from that host. Worker output is transferred as a bounded patch into a local isolated worktree; Axiom does not automatically integrate it into your project.</small>
  </section>;
}
