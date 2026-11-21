export type ProjectMemoryKind = "convention" | "decision" | "accepted-fix" | "known-failure";
export type ProjectMemoryRecord = {
  id: string;
  projectId: string;
  kind: ProjectMemoryKind;
  title: string;
  content: string;
  source: { type: "user" | "verified-task" | "repository"; reference: string };
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  confidence: number;
  tags: string[];
};
export type ProjectMemorySnapshot = { version: 1; projectId: string; revision: number; records: ProjectMemoryRecord[] };
const SECRET_KEY = /(password|secret|token|api[_-]?key|private[_-]?key|authorization|credential|dsn)/i;
const SECRET_VALUE = /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sbp_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
const MAX_RECORDS = 5000;
function cleanText(value: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /\0/.test(value) || SECRET_VALUE.test(value)) throw new TypeError("Project memory contains invalid or sensitive content.");
  return value.trim();
}
export function createProjectMemorySnapshot(projectId: string): ProjectMemorySnapshot {
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(projectId)) throw new TypeError("Invalid project memory scope.");
  return { version: 1, projectId, revision: 0, records: [] };
}
export function upsertProjectMemory(snapshot: ProjectMemorySnapshot, input: Omit<ProjectMemoryRecord, "projectId" | "createdAt" | "updatedAt">, now = Date.now()): ProjectMemorySnapshot {
  if (!snapshot || snapshot.version !== 1 || !snapshot.projectId || !Array.isArray(snapshot.records) || snapshot.records.length > MAX_RECORDS) throw new Error("Invalid project memory snapshot.");
  if (!/^[A-Za-z0-9._:-]{1,160}$/.test(input.id) || !["convention", "decision", "accepted-fix", "known-failure"].includes(input.kind)) throw new TypeError("Invalid project memory identity or kind.");
  const title = cleanText(input.title, 180);
  const content = cleanText(input.content, 8000);
  if (!input.source || !["user", "verified-task", "repository"].includes(input.source.type)) throw new TypeError("Project memory provenance is required.");
  const reference = cleanText(input.source.reference, 240);
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) throw new TypeError("Project memory confidence must be between 0 and 1.");
  const existing = snapshot.records.find(record => record.id === input.id);
  const record: ProjectMemoryRecord = {
    id: input.id, projectId: snapshot.projectId, kind: input.kind, title, content,
    source: { type: input.source.type, reference }, createdAt: existing?.createdAt ?? now, updatedAt: now,
    expiresAt: input.expiresAt === null ? null : Number.isFinite(input.expiresAt) && input.expiresAt > now ? input.expiresAt : null,
    confidence: input.confidence, tags: [...new Set(input.tags.filter(tag => typeof tag === "string" && /^[a-z0-9-]{1,40}$/i.test(tag)))].slice(0, 30)
  };
  return { version: 1, projectId: snapshot.projectId, revision: snapshot.revision + 1, records: [...snapshot.records.filter(item => item.id !== input.id), record].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_RECORDS) };
}
export function retrieveProjectMemory(snapshot: ProjectMemorySnapshot, query: string, now = Date.now(), limit = 12): ProjectMemoryRecord[] {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.records) || typeof query !== "string") return [];
  const terms = query.toLowerCase().split(/[^a-z0-9_-]+/).filter(term => term.length > 1).slice(0, 30);
  if (!terms.length) return [];
  return snapshot.records.filter(record => record.projectId === snapshot.projectId && (!record.expiresAt || record.expiresAt > now))
    .map(record => ({ record, score: terms.reduce((score, term) => score + ((record.title + " " + record.content + " " + record.tags.join(" ")).toLowerCase().includes(term) ? 1 : 0), 0) + record.confidence * 0.25 }))
    .filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
    .slice(0, Math.min(Math.max(Math.floor(limit), 1), 50)).map(item => ({ ...item.record }));
}
export function removeProjectMemory(snapshot: ProjectMemorySnapshot, id: string): ProjectMemorySnapshot {
  return { ...snapshot, revision: snapshot.revision + 1, records: snapshot.records.filter(record => record.id !== id) };
}
