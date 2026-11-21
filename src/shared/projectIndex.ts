export type ProjectIndexEntry = {
  path: string;
  kind: "source" | "config" | "documentation" | "asset" | "other";
  size: number;
  modifiedAt: number;
  contentHash: string;
  imports: string[];
  symbols: string[];
};
export type ProjectIndexSnapshot = { version: 1; projectId: string; revision: number; updatedAt: number; entries: ProjectIndexEntry[] };
export type IndexInput = Omit<ProjectIndexEntry, "path"> & { path: string };
const MAX_FILES = 100000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const ignored = new Set(["node_modules", ".git", "dist", "out", "build", ".next", ".cache", "coverage"]);
function normalizePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 1024 || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) throw new Error("Unsafe project index path.");
  const segments = value.split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".." || ignored.has(segment))) throw new Error("Unsafe or excluded project index path.");
  return segments.join("/");
}
export function classifyProjectFile(path: string): ProjectIndexEntry["kind"] {
  const lower = path.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|cs|cpp|h|vue|svelte)$/.test(lower)) return "source";
  if (/(^|\/)(package\.json|tsconfig[^/]*\.json|vite\.config\.[^/]+|.*\.ya?ml|.*\.toml|\.env\.example)$/.test(lower)) return "config";
  if (/\.(md|mdx|rst|txt)$/.test(lower)) return "documentation";
  if (/\.(png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|pdf)$/.test(lower)) return "asset";
  return "other";
}
export function updateProjectIndex(previous: ProjectIndexSnapshot | null, projectId: string, changed: readonly IndexInput[], removed: readonly string[], now = Date.now()): ProjectIndexSnapshot {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(projectId) || !Array.isArray(changed) || changed.length > MAX_FILES || !Array.isArray(removed) || removed.length > MAX_FILES) throw new TypeError("Invalid project index update.");
  const entries = new Map<string, ProjectIndexEntry>();
  if (previous) {
    if (previous.version !== 1 || previous.projectId !== projectId || !Array.isArray(previous.entries)) throw new Error("Project index schema or project scope mismatch.");
    for (const entry of previous.entries) entries.set(normalizePath(entry.path), entry);
  }
  for (const path of removed) entries.delete(normalizePath(path));
  for (const input of changed) {
    const path = normalizePath(input.path);
    if (!Number.isSafeInteger(input.size) || input.size < 0 || input.size > MAX_FILE_BYTES || !Number.isFinite(input.modifiedAt) || typeof input.contentHash !== "string" || !/^[a-f0-9]{32,128}$/i.test(input.contentHash)) throw new TypeError("Invalid project index file metadata.");
    entries.set(path, { path, kind: classifyProjectFile(path), size: input.size, modifiedAt: input.modifiedAt, contentHash: input.contentHash, imports: input.imports.filter(value => typeof value === "string").slice(0, 500), symbols: input.symbols.filter(value => typeof value === "string").slice(0, 2000) });
  }
  if (entries.size > MAX_FILES) throw new RangeError("Project index file limit exceeded.");
  return { version: 1, projectId, revision: (previous?.revision ?? 0) + 1, updatedAt: now, entries: [...entries.values()].sort((a, b) => a.path.localeCompare(b.path)) };
}
export function findProjectImpact(index: ProjectIndexSnapshot, changedPaths: readonly string[]): string[] {
  const changed = new Set(changedPaths.map(normalizePath));
  const impacted = new Set(changed);
  for (const entry of index.entries) if (entry.imports.some(value => changed.has(value))) impacted.add(entry.path);
  return [...impacted].sort();
}
