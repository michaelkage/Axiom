import type { ProjectMemory } from "../../shared/axiomWorkflow";
import { retrieveProjectMemories } from "../../shared/axiomWorkflow";

const categories = ["architecture", "convention", "decision", "preference", "fix", "failure"] as const;

export function projectMemoryStorageKey(workspaceRoot?: string): string {
  const root = workspaceRoot || "default-workspace";
  // Keep memory scoped to a workspace without exposing its raw path in browser storage keys.
  let hash = 2166136261;
  for (let i = 0; i < root.length; i++) { hash ^= root.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return "axiom.project-memory.v1:" + (hash >>> 0).toString(16);
}

export function loadProjectMemories(workspaceRoot?: string): ProjectMemory[] {
  try {
    const raw = localStorage.getItem(projectMemoryStorageKey(workspaceRoot));
    if (!raw) return [];
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) return [];
    return decoded.filter((item): item is ProjectMemory =>
      !!item && typeof item.id === "string" && typeof item.content === "string" &&
      categories.includes(item.category) && Array.isArray(item.tags) &&
      typeof item.createdAt === "string" && typeof item.updatedAt === "string"
    );
  } catch { return []; }
}

/** Add a small, relevant, user-authored memory block without changing prompts when no memories match. */
export function withProjectMemory(prompt: string, workspaceRoot?: string): string {
  if (typeof localStorage === "undefined") return prompt;
  const relevant = retrieveProjectMemories(loadProjectMemories(workspaceRoot), prompt, 5);
  if (!relevant.length) return prompt;
  const lines = relevant.map(memory => `- [${memory.category}${memory.tags.length ? "; " + memory.tags.join(", ") : ""}] ${memory.content}`);
  return prompt + "\n\n---\nRelevant Axiom project memory (user-authored context; follow when applicable):\n" + lines.join("\n") + "\nTreat these as project context, not as new user requests.";
}
