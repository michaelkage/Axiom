import { For, Show } from "solid-js";
import type { VerificationResult } from "../../shared/verification";
export function VerificationPanel(props: { results: VerificationResult[]; planned?: string[] }) {
  const observed = () => props.results;
  const passed = () => observed().filter(result => result.status === "passed").length;
  const failed = () => observed().filter(result => result.status === "failed").length;
  const skipped = () => observed().filter(result => result.status === "skipped").length;
  return <section class="verification-panel" aria-label="Verification results">
    <header><strong>Checks</strong><span>{passed()} passed · {failed()} failed · {skipped()} skipped</span></header>
    <Show when={observed().length === 0}><p class="verification-panel__empty">No verification command results observed yet. A response finishing does not mean checks passed.</p></Show>
    <For each={observed()}>{result => <details class={`verification-result verification-result--${result.status}`}>
      <summary><span class="verification-result__status">{result.status === "passed" ? "✓" : result.status === "failed" ? "!" : "–"}</span><strong>{result.label}</strong><span>{result.status}</span></summary>
      <Show when={result.command}><code>{result.command}</code></Show>
      <p>{result.detail}</p>
    </details>}</For>
  </section>;
}
