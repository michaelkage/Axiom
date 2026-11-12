const MENTION_PATTERN = /(^|\s)@(file|folder|git-diff|memory)(?::([^\s]+))?/g;

export function parseContextMentions(input) {
  const text = String(input || "");
  const mentions = [];
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const kind = match[2];
    const target = match[3] || "";
    if ((kind === "file" || kind === "folder") && !target) continue;
    if (target.length > 240 || target.includes("\0")) continue;
    mentions.push({ kind, target, start: match.index + match[1].length, end: match.index + match[0].length });
  }
  return mentions;
}

export function buildContextMentionPrompt(mentions, resolved = []) {
  if (!Array.isArray(mentions) || !mentions.length) return "";
  const sections = mentions.map((mention, index) => {
    const item = resolved[index];
    if (!item || typeof item.content !== "string") return "[" + mention.kind + (mention.target ? ":" + mention.target : "") + " requested but not resolved]";
    return "--- PINNED " + mention.kind.toUpperCase() + (mention.target ? ": " + mention.target : "") + " ---\n" + item.content.slice(0, 30000) + "\n--- END PINNED CONTEXT ---";
  });
  return "\n\nExplicit user-pinned context:\n" + sections.join("\n\n");
}
