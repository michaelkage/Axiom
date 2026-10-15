import { createSignal, For, Show, onMount } from "solid-js";

export interface ProviderReadinessModel {
  providerID: string;
  modelID: string;
  name: string;
}

export interface ProviderReadinessProvider {
  id: string;
  name: string;
  connected: boolean;
  models: ProviderReadinessModel[];
}

export interface ProviderReadinessSnapshot {
  providers: ProviderReadinessProvider[];
  warnings: string[];
}

interface Props {
  loadReadiness: () => Promise<ProviderReadinessSnapshot>;
  testConnection: (providerID: string, modelID: string) => Promise<void>;
}

export function ProviderReadinessPanel(props: Props) {
  const [snapshot, setSnapshot] = createSignal<ProviderReadinessSnapshot | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [testing, setTesting] = createSignal<string | null>(null);
  const [testResults, setTestResults] = createSignal<Record<string, { ok: boolean; message: string }>>({});
  const [expanded, setExpanded] = createSignal(false);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await props.loadReadiness());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSnapshot(null);
    } finally {
      setLoading(false);
    }
  };

  onMount(() => { void refresh(); });

  const test = async (providerID: string, modelID: string) => {
    const key = providerID + "/" + modelID;
    setTesting(key);
    setTestResults(previous => ({ ...previous, [key]: { ok: false, message: "Testing model response…" } }));
    try {
      await props.testConnection(providerID, modelID);
      setTestResults(previous => ({ ...previous, [key]: { ok: true, message: "Model responded successfully. Connection and credentials are working." } }));
    } catch (cause) {
      setTestResults(previous => ({ ...previous, [key]: { ok: false, message: cause instanceof Error ? cause.message : String(cause) } }));
    } finally {
      setTesting(null);
    }
  };

  const connectedProviders = () => snapshot()?.providers.filter(provider => provider.connected) ?? [];
  const availableModelCount = () => connectedProviders().reduce((count, provider) => count + provider.models.length, 0);

  return (
    <section class="provider-onboarding provider-readiness" aria-labelledby="provider-readiness-title">
      <div class="provider-onboarding__eyebrow">MODEL ACCESS CHECK</div>
      <h2 id="provider-readiness-title">Check provider readiness</h2>
      <p>Inspect the providers and models the local runtime can see, then send a small test request before starting a build. Test requests may use a small amount of your provider's quota.</p>
      <div class="provider-readiness__summary" aria-live="polite">
        <strong>{loading() ? "Checking model access…" : snapshot() ? (connectedProviders().length + " connected provider(s) · " + availableModelCount() + " available model(s)") : "Model access has not been checked"}</strong>
        <button type="button" class="workflow-plan__secondary" disabled={loading()} onClick={() => void refresh()}>{loading() ? "Checking…" : "Refresh checks"}</button>
      </div>
      <Show when={error()}>
        <div class="provider-readiness__issue" role="alert">
          <strong>Could not inspect provider configuration</strong>
          <p>{error()}</p>
          <p>Confirm the Axiom runtime is running and the project connection is available, then refresh. No credentials are displayed by this check.</p>
        </div>
      </Show>
      <Show when={snapshot() && connectedProviders().length === 0}>
        <div class="provider-readiness__issue">
          <strong>No connected provider was reported</strong>
          <p>Configure a provider in the OpenCode runtime first. Provider credentials stay in the runtime's supported credential store; do not put API keys in project prompts or source files.</p>
          <button type="button" class="workflow-plan__secondary" onClick={() => setExpanded(value => !value)}>{expanded() ? "Hide next steps" : "Show next steps"}</button>
          <Show when={expanded()}>
            <ol>
              <li>Open the runtime's provider authentication flow and sign in or add a provider key.</li>
              <li>Return here and refresh provider checks.</li>
              <li>Select a listed model and run its connection test before building.</li>
            </ol>
          </Show>
        </div>
      </Show>
      <Show when={snapshot() && connectedProviders().length > 0}>
        <div class="provider-readiness__providers">
          <For each={connectedProviders()}>{provider => (
            <div class="provider-readiness__provider">
              <div class="provider-readiness__provider-heading">
                <strong>{provider.name}</strong>
                <span class="provider-readiness__status">Connected</span>
              </div>
              <Show when={provider.models.length > 0} fallback={<p>No selectable models were returned for this provider. Refresh the model catalogue or check provider-specific configuration.</p>}>
                <ul>
                  <For each={provider.models}>{model => {
                    const key = model.providerID + "/" + model.modelID;
                    const result = () => testResults()[key];
                    return <li>
                      <div><strong>{model.name}</strong><small>{key}</small></div>
                      <button type="button" class="workflow-plan__secondary" disabled={testing() !== null} onClick={() => void test(model.providerID, model.modelID)}>{testing() === key ? "Testing…" : "Test model"}</button>
                      <Show when={result()}><p class={result()!.ok ? "provider-readiness__success" : "provider-readiness__issue"} role="status">{result()!.message}</p></Show>
                    </li>;
                  }}</For>
                </ul>
              </Show>
            </div>
          )}</For>
        </div>
      </Show>
      <Show when={snapshot()?.warnings.length}>
        <div class="provider-readiness__issue">
          <strong>Things to review</strong>
          <ul><For each={snapshot()?.warnings}>{warning => <li>{warning}</li>}</For></ul>
        </div>
      </Show>
      <p class="provider-readiness__footnote">A listed model is discoverable, not guaranteed to be usable. A successful test confirms a real response at this moment; quotas, permissions, and provider availability can change.</p>
    </section>
  );
}
