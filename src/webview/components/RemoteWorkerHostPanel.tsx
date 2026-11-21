import { createSignal, onMount, Show } from "solid-js";

interface RemoteWorkerSettings {
  hostUrl: string;
  repositoryUrl: string;
  branch: string;
  enabled: boolean;
  tokenConfigured: boolean;
}
interface RemoteWorkerBridge {
  config(): Promise<RemoteWorkerSettings>;
  save(request: { hostUrl: string; repositoryUrl: string; branch: string; token: string; enabled: boolean }): Promise<RemoteWorkerSettings>;
}
function bridge(): RemoteWorkerBridge | undefined {
  return (window as unknown as { axiomDesktop?: { remoteWorker?: RemoteWorkerBridge } }).axiomDesktop?.remoteWorker;
}
export function RemoteWorkerHostPanel() {
  const [hostUrl, setHostUrl] = createSignal("");
  const [repositoryUrl, setRepositoryUrl] = createSignal("");
  const [branch, setBranch] = createSignal("main");
  const [token, setToken] = createSignal("");
  const [tokenConfigured, setTokenConfigured] = createSignal(false);
  const [enabled, setEnabled] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [notice, setNotice] = createSignal("");

  onMount(() => {
    void bridge()?.config().then(settings => {
      setHostUrl(settings.hostUrl || "");
      setRepositoryUrl(settings.repositoryUrl || "");
      setBranch(settings.branch || "main");
      setEnabled(settings.enabled === true);
      setTokenConfigured(settings.tokenConfigured === true);
    }).catch(error => setNotice(error instanceof Error ? error.message : "Could not load remote worker settings."));
  });

  const save = async () => {
    const api = bridge();
    if (!api || busy()) return;
    setBusy(true); setNotice("");
    try {
      const settings = await api.save({
        hostUrl: hostUrl().trim(),
        repositoryUrl: repositoryUrl().trim(),
        branch: branch().trim(),
        token: token(),
        enabled: enabled(),
      });
      setToken(""); setTokenConfigured(settings.tokenConfigured === true);
      setEnabled(settings.enabled === true);
      setNotice(settings.enabled
        ? "Remote workers enabled. New parallel tasks will run on the configured Worker Host; results return to local isolated review worktrees."
        : "Worker Host settings saved. Parallel tasks will continue using the local runtime.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Could not save remote worker settings."); }
    finally { setBusy(false); }
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
      <button type="button" disabled={busy() || !bridge()} onClick={() => void save()}>{busy() ? "Saving…" : "Save Worker Host settings"}</button>
    </div>
    <Show when={notice()}><p role="status">{notice()}</p></Show>
    <small>Remote execution requires a running Axiom Worker Host and Git access from that host. Worker output is transferred as a bounded patch into a local isolated worktree; Axiom does not automatically integrate it into your project.</small>
  </section>;
}
