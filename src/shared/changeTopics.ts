export interface ChangeFile {
  file: string;
  before?: string;
  after?: string;
  additions?: number;
  deletions?: number;
}
export interface ChangeTopic {
  id: string;
  title: string;
  summary: string;
  files: ChangeFile[];
  additions: number;
  deletions: number;
}
function titleForPath(file: string): { title: string; summary: string } {
  const path = file.toLowerCase();
  if (/\.(test|spec)\.[^.]+$/.test(path) || /(^|\/)(__tests__|tests?)\//.test(path))
    return { title: "Added or updated tests", summary: "Changed automated coverage and test fixtures" };
  if (/readme|\.md$|docs?\//.test(path))
    return { title: "Updated project documentation", summary: "Changed setup guidance, documentation, or project notes" };
  if (/\.ya?ml$|\.json$|\.toml$|\.config\.|vite\.config|tsconfig/.test(path))
    return { title: "Updated project configuration", summary: "Changed build, tooling, or application configuration" };
  if (/\.css$|\.scss$|\.sass$/.test(path))
    return { title: "Updated interface styling", summary: "Changed layout, visual design, or responsive behavior" };
  if (/components?\//.test(path) || /\.(tsx|jsx)$/.test(path))
    return { title: "Updated interface behavior", summary: "Changed a UI component or interactive experience" };
  if (/api|service|client|transport|server|backend/.test(path))
    return { title: "Updated application logic", summary: "Changed runtime behavior, data flow, or service integration" };
  return { title: "Updated project files", summary: "Changed implementation files in this area" };
}
export function groupChangeTopics(files: ChangeFile[]): ChangeTopic[] {
  const groups = new Map<string, ChangeTopic>();
  for (const file of files) {
    const { title, summary } = titleForPath(file.file);
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    let topic = groups.get(id);
    if (!topic) {
      topic = { id, title, summary, files: [], additions: 0, deletions: 0 };
      groups.set(id, topic);
    }
    topic.files.push(file);
    topic.additions += Math.max(0, file.additions ?? 0);
    topic.deletions += Math.max(0, file.deletions ?? 0);
  }
  return [...groups.values()];
}
export function toUnifiedDiff(file: ChangeFile): string {
  if (file.before === undefined && file.after === undefined) return "";
  const before = (file.before ?? "").split("\n");
  const after = (file.after ?? "").split("\n");
  const lines = [`--- a/${file.file}`, `+++ b/${file.file}`, `@@ -1,${file.before === undefined ? 0 : before.length} +1,${file.after === undefined ? 0 : after.length} @@`];
  lines.push(...before.map(line => `-${line}`), ...after.map(line => `+${line}`));
  return lines.join("\n");
}
