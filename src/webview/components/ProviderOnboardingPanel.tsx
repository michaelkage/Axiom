import { createSignal, Show } from "solid-js";

export function ProviderOnboardingPanel() {
  const [expanded, setExpanded] = createSignal(false);
  return (
    <section class="provider-onboarding" aria-labelledby="provider-onboarding-title">
      <div class="provider-onboarding__eyebrow">FIRST-RUN SETUP</div>
      <h2 id="provider-onboarding-title">Connect a model before you build</h2>
      <p>Axiom includes the desktop workspace and local runtime. Model access is configured separately, so you can choose a hosted provider or a local model setup that you already run.</p>
      <div class="provider-onboarding__steps">
        <div><span>1</span><div><strong>Choose a provider</strong><p>Pick a model provider that supports the models and tools you want to use.</p></div></div>
        <div><span>2</span><div><strong>Configure access</strong><p>Follow the provider's sign-in or API-key setup instructions. Keep keys in the provider's supported credential store; don't paste secrets into project prompts.</p></div></div>
        <div><span>3</span><div><strong>Select a model</strong><p>Choose a model available to your account or your configured local server. Tool use and context limits vary by model.</p></div></div>
        <div><span>4</span><div><strong>Run a small first task</strong><p>Ask Axiom to explain a file or make one contained change, then inspect the diff and verification results before integrating anything.</p></div></div>
      </div>
      <div class="provider-onboarding__actions">
        <a href="https://opencode.ai/docs/providers/" target="_blank" rel="noreferrer">Provider setup guide ↗</a>
        <button type="button" class="workflow-plan__secondary" onClick={() => setExpanded(value => !value)}>{expanded() ? "Hide setup tips" : "Show setup tips"}</button>
      </div>
      <Show when={expanded()}>
        <div class="provider-onboarding__tips">
          <p><strong>Hosted provider:</strong> confirm the account has access to the selected model and that credentials are configured for the OpenCode runtime.</p>
          <p><strong>Local provider:</strong> start your model server first, confirm its endpoint and model name, and check that the model supports tool calls if you expect Axiom to edit files.</p>
          <p><strong>Keep it safe:</strong> never commit API keys to a project, and redact secrets from diagnostic logs before sharing them.</p>
        </div>
      </Show>
    </section>
  );
}
