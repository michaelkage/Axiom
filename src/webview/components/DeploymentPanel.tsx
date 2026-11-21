import { createSignal, Show } from "solid-js";

type DeploymentProvider = "vercel" | "netlify" | "cloudflare-pages";
interface DeploymentResult {
  provider: DeploymentProvider;
  target: "preview";
  previewUrl: string;
  durationMs: number;
  status: "deployed";
}
interface DeploymentBridge {
  secureStorage: { set(namespace: string, key: string, value: string): Promise<unknown> };
  deployment: { preview(request: Record<string, unknown>): Promise<DeploymentResult> };
}
function bridge(): DeploymentBridge | undefined {
  return (window as unknown as { axiomDesktop?: DeploymentBridge }).axiomDesktop;
}

export function DeploymentPanel(props: { workspaceRoot?: string }) {
  const [provider, setProvider] = createSignal<DeploymentProvider>("vercel");
  const [credential, setCredential] = createSignal("");
  const [outputDirectory, setOutputDirectory] = createSignal("dist");
  const [siteId, setSiteId] = createSignal("");
  const [projectName, setProjectName] = createSignal("");
  const [accountId, setAccountId] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const [result, setResult] = createSignal<DeploymentResult | null>(null);

  const saveCredential = async () => {
    const api = bridge();
    if (!api || !credential().trim()) return;
    try {
      await api.secureStorage.set("deployment", provider(), credential().trim());
      setCredential("");
      setMessage("Provider credential saved in OS-backed secure storage.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not save provider credential.");
    }
  };

  const deploy = async () => {
    const api = bridge();
    if (!api || !props.workspaceRoot || busy()) return;
    setBusy(true);
    setMessage("");
    setResult(null);
    try {
      const deployed = await api.deployment.preview({
        provider: provider(),
        target: "preview",
        projectRoot: props.workspaceRoot,
        outputDirectory: outputDirectory().trim(),
        ...(provider() === "netlify" ? { siteId: siteId().trim() } : {}),
        ...(provider() === "cloudflare-pages" ? { projectName: projectName().trim(), accountId: accountId().trim(), branch: "axiom-preview" } : {}),
      });
      setResult(deployed);
      setMessage("Preview deployment completed. Axiom has received the provider URL.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview deployment failed.");
    } finally {
      setBusy(false);
    }
  };

  return <section class="axiom-deployment" aria-label="Deployment previews">
    <div class="axiom-deployment__heading">
      <div><strong>Deployment previews</strong><small>Deploy a built project to a temporary preview URL</small></div>
      <span>PREVIEW ONLY</span>
    </div>
    <label>Provider
      <select value={provider()} onChange={event => { setProvider(event.currentTarget.value as DeploymentProvider); setResult(null); setMessage(""); }}>
        <option value="vercel">Vercel CLI</option>
        <option value="netlify">Netlify CLI</option>
        <option value="cloudflare-pages">Cloudflare Pages / Wrangler</option>
      </select>
    </label>
    <label>Build output directory
      <input value={outputDirectory()} onInput={event => setOutputDirectory(event.currentTarget.value)} placeholder="dist" />
    </label>
    <Show when={provider() === "netlify"}>
      <label>Netlify site ID
        <input value={siteId()} onInput={event => setSiteId(event.currentTarget.value)} placeholder="Your linked Netlify site ID" />
      </label>
    </Show>
    <Show when={provider() === "cloudflare-pages"}>
      <label>Cloudflare Pages project name
        <input value={projectName()} onInput={event => setProjectName(event.currentTarget.value)} placeholder="my-pages-project" />
      </label>
      <label>Cloudflare account ID
        <input value={accountId()} onInput={event => setAccountId(event.currentTarget.value)} placeholder="Account ID" />
      </label>
    </Show>
    <label>Provider credential
      <input type="password" autocomplete="off" value={credential()} onInput={event => setCredential(event.currentTarget.value)} placeholder="Paste provider token" />
    </label>
    <div class="axiom-deployment__actions">
      <button type="button" disabled={!credential().trim() || busy() || !bridge()} onClick={() => void saveCredential()}>Save credential securely</button>
      <button type="button" disabled={!props.workspaceRoot || busy() || !outputDirectory().trim() || !bridge()} onClick={() => void deploy()}>{busy() ? "Deploying preview…" : "Create preview"}</button>
    </div>
    <Show when={message()}><p role="status">{message()}</p></Show>
    <Show when={result()}>
      <p class="axiom-deployment__result"><strong>Preview ready</strong> · {Math.round(result()!.durationMs / 1000)}s</p>
      <a href={result()!.previewUrl} target="_blank" rel="noreferrer">{result()!.previewUrl}</a>
    </Show>
    <small>Install the selected provider CLI and build the project first. Production deployment is deliberately not exposed by this workflow.</small>
  </section>;
}
