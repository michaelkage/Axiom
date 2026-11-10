import { createSignal, onMount, Show, For } from "solid-js";

type OmniRouteModel = { id: string; name: string };
type OmniRouteStatus = {
  config: { baseUrl: string; model: string; enabled: boolean; autoStart: boolean; hasApiKey: boolean };
  endpoint: { reachable: boolean; authenticated: boolean; models: OmniRouteModel[]; message: string };
  installed: boolean; ownedProcessRunning: boolean; installing: boolean; installGuide: string; log: string;
};
type OmniRouteBridge = {
  status: () => Promise<OmniRouteStatus>;
  check: (settings: { baseUrl: string; apiKey: string }) => Promise<OmniRouteStatus["endpoint"]>;
  save: (settings: { baseUrl: string; model: string; enabled: boolean; autoStart: boolean; apiKey: string }) => Promise<{ saved: boolean; requiresRestart: boolean }>;
  install: () => Promise<unknown>;
  start: () => Promise<unknown>;
  stop: () => Promise<unknown>;
  openDashboard: () => Promise<unknown>;
};

export function OmniRouteSetupPanel() {
  const [status, setStatus] = createSignal<OmniRouteStatus | null>(null);
  const [baseUrl, setBaseUrl] = createSignal("http://127.0.0.1:20128/v1");
  const [model, setModel] = createSignal("auto");
  const [apiKey, setApiKey] = createSignal("");
  const [enabled, setEnabled] = createSignal(false);
  const [autoStart, setAutoStart] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [message, setMessage] = createSignal("");
  const bridge = (window as unknown as { axiomDesktop?: { omniRoute?: OmniRouteBridge } }).axiomDesktop?.omniRoute;

  const refresh = async () => {
    if (!bridge) return;
    try {
      const result = await bridge.status();
      setStatus(result);
      setBaseUrl(result.config.baseUrl);
      setModel(result.config.model);
      setEnabled(result.config.enabled);
      setAutoStart(result.config.autoStart);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
  };

  onMount(() => { void refresh(); });

  const run = async (action: "save" | "check" | "install" | "start" | "stop" | "dashboard") => {
    if (!bridge) { setMessage("OmniRoute management is available in the Axiom desktop app."); return; }
    setBusy(true);
    setMessage("");
    try {
      if (action === "save") {
        const result = await bridge.save({ baseUrl: baseUrl().trim(), model: model().trim() || "auto", enabled: enabled(), autoStart: autoStart(), apiKey: apiKey() });
        setApiKey("");
        setMessage(result.requiresRestart ? "Saved. Restart Axiom to apply the selected OmniRoute model to OpenCode sessions." : "Settings saved.");
      } else if (action === "check") {
        const endpoint = await bridge.check({ baseUrl: baseUrl().trim(), apiKey: apiKey() });
        setStatus(current => current ? { ...current, endpoint } : null);
        setMessage(endpoint.message);
      } else if (action === "install") {
        await bridge.install();
        setMessage("OmniRoute installed. Save your settings, then start the router.");
      } else if (action === "start") {
        await bridge.start();
        setMessage("OmniRoute is responding.");
      } else if (action === "stop") {
        const result = await bridge.stop() as { stopped?: boolean };
        setMessage(result.stopped ? "Axiom stopped the OmniRoute process it launched." : "Axiom did not stop a router it does not own.");
      } else if (action === "dashboard") {
        await bridge.openDashboard();
      }
      await refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };

  return (
    <section class="omniroute-setup" aria-labelledby="omniroute-setup-title">
      <div class="omniroute-setup__eyebrow">OPTIONAL LOCAL ROUTER</div>
      <h2 id="omniroute-setup-title">Connect OmniRoute</h2>
      <p>Use a router you already run, install OmniRoute with your approval, or let Axiom launch its local instance at startup. This is optional: direct providers, local model servers, custom URLs, and your existing OpenCode credentials remain supported.</p>
      <div class="omniroute-setup__status" role="status">
        <span class={status()?.endpoint.reachable ? "omniroute-dot omniroute-dot--on" : "omniroute-dot"} />
        <div><strong>{status()?.endpoint.reachable ? "Endpoint reachable" : "Not connected yet"}</strong><small>{status()?.endpoint.message || "Checking configured endpoint…"}</small></div>
        <span class="omniroute-setup__spacer" />
        <button type="button" class="workflow-plan__secondary" disabled={busy()} onClick={() => void run("check")}>Check connection</button>
      </div>
      <label class="omniroute-setup__field">OpenAI-compatible API base URL
        <input value={baseUrl()} onInput={event => setBaseUrl(event.currentTarget.value)} placeholder="http://127.0.0.1:20128/v1" disabled={busy()} />
      </label>
      <label class="omniroute-setup__field">Model ID
        <input list="omniroute-model-options" value={model()} onInput={event => setModel(event.currentTarget.value)} placeholder="auto" disabled={busy()} />
        <datalist id="omniroute-model-options"><For each={status()?.endpoint.models || []}>{item => <option value={item.id}>{item.name}</option>}</For></datalist>
      </label>
      <label class="omniroute-setup__field">Router API key <span class="omniroute-setup__hint">{status()?.config.hasApiKey ? "A key is saved securely. Leave blank to keep it." : "Optional if your endpoint does not require authentication."}</span>
        <input type="password" autocomplete="off" value={apiKey()} onInput={event => setApiKey(event.currentTarget.value)} placeholder={status()?.config.hasApiKey ? "Saved securely" : "Paste router key"} disabled={busy()} />
      </label>
      <label class="omniroute-setup__toggle"><input type="checkbox" checked={enabled()} onChange={event => setEnabled(event.currentTarget.checked)} disabled={busy()} /> Attach OmniRoute as Axiom's default OpenCode provider on next startup</label>
      <label class="omniroute-setup__toggle"><input type="checkbox" checked={autoStart()} onChange={event => setAutoStart(event.currentTarget.checked)} disabled={busy() || !enabled()} /> Launch local OmniRoute automatically when Axiom starts</label>
      <div class="omniroute-setup__actions">
        <button type="button" class="workflow-plan__secondary" disabled={busy()} onClick={() => void run("save")}>Save settings</button>
        <button type="button" class="workflow-plan__secondary" disabled={busy() || !status()?.installed} onClick={() => void run("start")}>Start router</button>
        <button type="button" class="workflow-plan__secondary" disabled={busy() || !status()?.ownedProcessRunning} onClick={() => void run("stop")}>Stop Axiom-launched router</button>
        <button type="button" class="workflow-plan__secondary" disabled={busy()} onClick={() => void run("dashboard")}>Open router dashboard</button>
        <Show when={!status()?.installed}><button type="button" class="workflow-plan__primary" disabled={busy()} onClick={() => void run("install")}>Install OmniRoute</button></Show>
      </div>
      <Show when={message()}><p class="omniroute-setup__message">{message()}</p></Show>
      <Show when={status()?.log}><pre class="omniroute-setup__log">{status()?.log}</pre></Show>
      <small class="omniroute-setup__note">Router installation runs only after you click Install. Axiom never stops an external router it did not launch. API keys are encrypted using the operating system's credential protection; if secure storage is unavailable, Axiom refuses to save the key.</small>
    </section>
  );
}
