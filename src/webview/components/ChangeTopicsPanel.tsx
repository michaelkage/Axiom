import { For, Show, createSignal } from "solid-js";
import type { FileDiff } from "../../shared/messages";
import { groupChangeTopics, toUnifiedDiff } from "../../shared/changeTopics";
import { DiffViewer } from "./parts/DiffViewer";
export function ChangeTopicsPanel(props: { diffs: FileDiff[] }) {
  const topics = () => groupChangeTopics(props.diffs);
  const [openFile, setOpenFile] = createSignal<string | null>(null);
  return <section class="change-topics" aria-label="Changes made">
    <header class="change-topics__header"><strong>What changed</strong><span>{props.diffs.length} file{props.diffs.length === 1 ? "" : "s"}</span></header>
    <For each={topics()}>{topic => <article class="change-topic">
      <div class="change-topic__title"><strong>{topic.title}</strong><span>+{topic.additions} / −{topic.deletions}</span></div>
      <p>{topic.summary}</p>
      <For each={topic.files}>{file => <div class="change-topic__file">
        <button type="button" class="change-topic__file-button" onClick={() => setOpenFile(openFile() === file.file ? null : file.file)} aria-expanded={openFile() === file.file}>
          <span>{file.file}</span><span>{openFile() === file.file ? "Hide diff −" : "Review diff +"}</span>
        </button>
        <Show when={openFile() === file.file}>
          <Show when={file.before !== undefined || file.after !== undefined} fallback={<p class="change-topic__no-diff">Diff content was not supplied for this file. Open it in the editor to review.</p>}>
            <DiffViewer diff={toUnifiedDiff(file)} />
          </Show>
        </Show>
      </div>}</For>
    </article>}</For>
  </section>;
}
