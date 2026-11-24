import { createMemo, createSignal, For, Show, createEffect, onCleanup } from "solid-js";
import type { ProjectMemory } from "../../shared/axiomWorkflow";
import { retrieveProjectMemories } from "../../shared/axiomWorkflow";
import { cacheProjectMemories, isProjectMemoryStale, loadProjectMemories, projectMemoryStorageKey } from "../utils/projectMemory";

type MemoryCategory = ProjectMemory["category"];
const categories: MemoryCategory[] = ["architecture", "convention", "decision", "preference", "fix", "failure"];
type ProjectMemoryApi = { load: () => Promise<ProjectMemory[]>; save: (memories: ProjectMemory[]) => Promise<ProjectMemory[]> };

export function ProjectMemoryPanel(props: { workspaceRoot?: string }) {
  const [memories, setMemories] = createSignal<ProjectMemory[]>([]);
  const [query, setQuery] = createSignal("");
  const [content, setContent] = createSignal("");
  const [category, setCategory] = createSignal<MemoryCategory>("convention");
  const [tags, setTags] = createSignal("");
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [expanded, setExpanded] = createSignal(false);
  const [storageError, setStorageError] = createSignal("");
  const [saving, setSaving] = createSignal(false);
  const desktopMemoryApi = () => (window as Window & { axiomDesktop?: { projectMemory?: ProjectMemoryApi } }).axiomDesktop?.projectMemory;
  const key = () => projectMemoryStorageKey(props.workspaceRoot);

  const persist = async (next: ProjectMemory[]): Promise<boolean> => {
    if (saving()) return false;
    setStorageError("");
    setSaving(true);
    try {
      const api = desktopMemoryApi();
      if (api && props.workspaceRoot) {
        const saved = await api.save(next);
        setMemories(saved);
        cacheProjectMemories(props.workspaceRoot, saved);
      } else {
        localStorage.setItem(key(), JSON.stringify(next));
        setMemories(next);
      }
      return true;
    } catch (error) {
      setStorageError(error instanceof Error ? error.message : "Could not save project memory.");
      return false;
    } finally {
      setSaving(false);
    }
  };

  createEffect(() => {
    const workspace = props.workspaceRoot;
    void key();
    setMemories(loadProjectMemories(workspace));
    setStorageError("");
    const api = desktopMemoryApi();
    if (api && workspace) {
      let active = true;
      void api.load().then(items => {
        if (active) {
          setMemories(items);
          cacheProjectMemories(workspace, items);
        }
      }).catch(error => {
        if (active) setStorageError(error instanceof Error ? error.message : "Could not load .axiom/memory.json.");
      });
      onCleanup(() => { active = false; });
    }
  });

  const visible = createMemo(() => {
    const all = memories();
    return query().trim() ? retrieveProjectMemories(all, query(), 50) : all;
  });
  const resetForm = () => { setContent(""); setTags(""); setCategory("convention"); setEditingId(null); };
  const save = async () => {
    const text = content().trim();
    if (!text || saving()) return;
    const now = new Date().toISOString(), id = editingId();
    const old = id ? memories().find(item => item.id === id) : undefined;
    const item: ProjectMemory = {
      id: old?.id ?? "memory-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8),
      category: category(), content: text,
      tags: [...new Set(tags().split(",").map(tag => tag.trim()).filter(Boolean))],
      createdAt: old?.createdAt ?? now, updatedAt: now,
    };
    const saved = await persist(old ? memories().map(memory => memory.id === item.id ? item : memory) : [item, ...memories()]);
    if (saved) resetForm();
  };
  const edit = (item: ProjectMemory) => {
    setEditingId(item.id); setContent(item.content); setCategory(item.category);
    setTags(item.tags.join(", ")); setExpanded(true);
  };
  const remove = (id: string) => {
    if (saving()) return;
    void persist(memories().filter(item => item.id !== id)).then(saved => {
      if (saved && editingId() === id) resetForm();
    });
  };
  const markReviewed = (item: ProjectMemory) => {
    if (!saving()) void persist(memories().map(memory => memory.id === item.id
      ? { ...memory, updatedAt: new Date().toISOString() } : memory));
  };

  return <section class="axiom-memory" aria-label="Project intelligence">
    <button class="axiom-memory__toggle" onClick={() => setExpanded(!expanded())} aria-expanded={expanded()}>
      <span><strong>Project intelligence</strong><small>{memories().length} saved memories · {desktopMemoryApi() && props.workspaceRoot ? ".axiom/memory.json · Git-versioned" : "browser-local"}</small></span>
      <span aria-hidden="true">{expanded() ? "−" : "+"}</span>
    </button>
    <Show when={expanded()}>
      <div class="axiom-memory__body">
        <p>Save architecture decisions, conventions, preferences, and useful fixes for future tasks. Desktop memories are stored in <code>.axiom/memory.json</code> and can be reviewed, committed, and synced with Git. Axiom never commits this file automatically.</p>
        <Show when={storageError()}><p role="alert" class="axiom-memory__stale">{storageError()}</p></Show>
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
          <button disabled={!content().trim() || saving()} onClick={save}>{saving() ? "Saving…" : editingId() ? "Update memory" : "Save memory"}</button>
          <Show when={editingId()}><button disabled={saving()} onClick={resetForm}>Cancel edit</button></Show>
        </div>
        <label>Find relevant memories
          <input value={query()} onInput={event => setQuery(event.currentTarget.value)} placeholder="Search by topic or tag" />
        </label>
        <Show when={visible().length === 0}><p class="axiom-memory__empty">No matching project memories yet.</p></Show>
        <For each={visible()}>{item => <article class="axiom-memory__item">
          <div><span class="axiom-memory__category">{item.category}</span><time>{new Date(item.updatedAt).toLocaleDateString()}</time><Show when={isProjectMemoryStale(item)}><span class="axiom-memory__stale" title="This memory has not been reviewed for 180 days or more">Needs review</span></Show></div>
          <p>{item.content}</p>
          <Show when={item.tags.length > 0}><small>{item.tags.join(" · ")}</small></Show>
          <div class="axiom-memory__actions"><button disabled={saving()} onClick={() => edit(item)}>Edit</button><Show when={isProjectMemoryStale(item)}><button disabled={saving()} onClick={() => markReviewed(item)}>Mark reviewed</button></Show><button disabled={saving()} onClick={() => remove(item.id)}>Delete</button></div>
        </article>}</For>
      </div>
    </Show>
  </section>;
}
