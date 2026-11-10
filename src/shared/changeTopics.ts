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
type DiffLine = { kind: "context" | "add" | "remove"; text: string };
function diffLines(before: string[], after: string[]): DiffLine[] {
  // Bound the dynamic-programming table so very large generated files remain safe to preview.
  if (before.length * after.length > 250_000) {
    return [
      ...before.map(text => ({ kind: "remove" as const, text })),
      ...after.map(text => ({ kind: "add" as const, text })),
    ];
  }
  const rows = before.length + 1;
  const cols = after.length + 1;
  const lcs = Array.from({ length: rows }, () => new Uint32Array(cols));
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      lines.push({ kind: "context", text: before[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: "remove", text: before[i++] });
    } else {
      lines.push({ kind: "add", text: after[j++] });
    }
  }
  while (i < before.length) lines.push({ kind: "remove", text: before[i++] });
  while (j < after.length) lines.push({ kind: "add", text: after[j++] });
  return lines;
}
export function toUnifiedDiff(file: ChangeFile): string {
  if (file.before === undefined && file.after === undefined) return "";
  const before = file.before === undefined ? [] : file.before.split("\n");
  const after = file.after === undefined ? [] : file.after.split("\n");
  const lines = diffLines(before, after);
  const changed = lines.map((line, index) => line.kind === "context" ? -1 : index).filter(index => index >= 0);
  if (changed.length === 0) return `--- a/${file.file}\n+++ b/${file.file}`;
  const context = 3;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length, index + context + 1);
    const previous = ranges[ranges.length - 1];
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }
  const oldBefore = new Array(lines.length + 1).fill(0);
  const newBefore = new Array(lines.length + 1).fill(0);
  for (let i = 0; i < lines.length; i++) {
    oldBefore[i + 1] = oldBefore[i] + (lines[i].kind === "add" ? 0 : 1);
    newBefore[i + 1] = newBefore[i] + (lines[i].kind === "remove" ? 0 : 1);
  }
  const output = [`--- a/${file.file}`, `+++ b/${file.file}`];
  for (const range of ranges) {
    const slice = lines.slice(range.start, range.end);
    const oldCount = slice.filter(line => line.kind !== "add").length;
    const newCount = slice.filter(line => line.kind !== "remove").length;
    const oldStart = oldCount === 0 ? oldBefore[range.start] : oldBefore[range.start] + 1;
    const newStart = newCount === 0 ? newBefore[range.start] : newBefore[range.start] + 1;
    output.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    output.push(...slice.map(line => `${line.kind === "context" ? " " : line.kind === "add" ? "+" : "-"}${line.text}`));
  }
  return output.join("\n");
}
