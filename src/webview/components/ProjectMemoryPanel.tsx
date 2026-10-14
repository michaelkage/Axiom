import { createMemo, createSignal, For, Show, onMount } from "solid-js";
import type { ProjectMemory } from "../../shared/axiomWorkflow";
import { retrieveProjectMemories } from "../../shared/axiomWorkflow";
import { vscode } from "../utils/vscode";

type MemoryCategory = ProjectMemory["category"];
const categories: MemoryCategory[] = ["architecture", "convention", "decision", "preference", "fix", "failure"];
function storageKey(project: string) { return "axiom.project-memory.v1:" + project; }
function safeProjectKey(root: string) {
  // Keep memory scoped to the workspace without persisting the raw path in the key.
  let hash = 2166136261;
  for (let i = 0; i < root.length; i++) { hash ^= root.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}
export function ProjectMemoryPanel(props: { workspaceRoot?: string }) {
  const [memories, setMemories] = createSignal<ProjectMemory[]>([]);
  const [query, setQuery] = createSignal("");
  const [content, setContent] = createSignal("");
  const [category, setCategory] = createSignal<MemoryCategory>("convention");
  const [tags, setTags] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal(false);
  const key = () => storageKey(safeProjectKey(props.workspaceRoot || "default-workspace"));
  const persist = (next: ProjectMemory[]) => {
    setMemories(next);
    try { localStorage.setItem(key(), JSON.stringify(next)); }
    catch { /* Storage can be disabled or full; current session remains usable. */ }
  };
  onMount(() => {
    try {
      const raw = localStorage.getItem(key());
      if (raw) {
        const decoded: unknown = JSON.parse(raw);
        if (Array.isArray(decoded)) setMemories(decoded.filter(item => item && typeof item.id === "string" && typeof item.content === "string" && categories.includes(item.category)));
      }
    } catch { setMemories([]); }
  });
  const visible = createMemo(() => {
    const all = memories();
    return query().trim() ? retrieveProjectMemories(all, query(), 50) : all;
  });
  const resetForm = () => { setContent(""); setTags(""); setCategory("convention"); setEditingId(null); };
  const save = () => {
    const text = content().trim();
    if (!text) return;
    const now = new Date().toISOString(), id = editingId();
    const old = id ? memories().find(item => item.id === id) : undefined;
    const item: ProjectMemory = {
      id: old?.id ?? "memory-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      category: category(), content: text,
      tags: [...new Set(tags().split(",").map(tag => tag.trim()).filter(Boolean))],
      createdAt: old?.createdAt ?? now, updatedAt: now,
    };
    persist(old ? memories().map(memory => memory.id === item.id ? item : memory) : [item, ...memories()]);
    resetForm();
  };
  const edit = (item: ProjectMemory) => { setEditingId(item.id); setContent(item.content); setCategory(item.category); setTags(item.tags.join(", ")); setExpanded(true); };
  const remove = (id: string) => { persist(memories().filter(item => item.id !== id)); if (editingId() === id) resetForm(); };
  return <section class="axiom-memory" aria-label="Project intelligence">
    <button class="axiom-memory__toggle" onClick={() => setExpanded(!expanded())} aria-expanded={expanded()}>
      <span><strong>Project intelligence</strong><small>{memories().length} saved memories · workspace scoped</small></span>
      <span aria-hidden="true">{expanded() ? "−" : "+"}</span>
    </button>
    <Show when={expanded()}>
      <div class="axiom-memory__body">
        <p>Save architecture decisions, conventions, preferences, and useful fixes for future tasks. Memories are editable and removable.</p>
        <label>Memory type
          <select value={category()} onChange={event => setCategory(event.currentTarget.value as MemoryCategory)}>
            <For each={categories}>{item => <option value={item}>{item}</option>}</For>
          </select>
        </label>
        <label>Memory
          <textarea value={content()} onInput={event => setContent(event.currentTarget.value)} placeholder="Example: Keep API handlers thin and put business logic in shared services." rows={3} />
        </label>
        <label>Tags, separated by commas
          <input value={tags()} onInput={event => setTags(event.currentTarget.value)} placeholder="architecture, api, testing" />
        </label>
        <div class="axiom-memory__actions">
          <button disabled={!content().trim()} onClick={save}>{editingId() ? "Update memory" : "Save memory"}</button>
          <Show when={editingId()}><button onClick={resetForm}>Cancel edit</button></Show>
        </div>
        <label>Find relevant memories
          <input value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder="Search by topic or tag" />
        </label>
        <Show when={visible().length === 0}><p class="axiom-memory__empty">No matching project memories yet.</p></Show>
        <For each={visible()}>{item => <article class="axiom-memory__item">
          <div><span class="axiom-memory__category">{item.category}</span><time>{new Date(item.updatedAt).toLocaleDateString()}</time></div>
          <p>{item.content}</p>
          <Show when={item.tags.length > 0}><small>{item.tags.join(" · ")}</small></Show>
          <div class="axiom-memory__actions"><button onClick={() => edit(item)}>Edit</button><button onClick={() => remove(item.id)}>Delete</button></div>
        </article>}</For>
      </div>
    </Show>
  </section>;
}
