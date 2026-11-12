const SECRET_PATTERNS = [
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g },
  { name: "authorization", pattern: /\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi },
  { name: "github-token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { name: "supabase-key", pattern: /\b(?:sb_secret_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "generic-assignment", pattern: /((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key)\s*[:=]\s*)(["']?)[^\s"'&,;]+\2/gi },
  { name: "env-assignment", pattern: /(^|\n)([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=)([^\r\n]*)/g }
];

export function redactSecrets(input, replacement = "[REDACTED]") {
  if (typeof input !== "string") return input;
  let output = input;
  for (const { name, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (...args) => {
      if (name === "authorization" || name === "generic-assignment") return args[1] + replacement;
      if (name === "env-assignment") return args[1] + args[2] + replacement;
      return replacement;
    });
  }
  return output;
}

export function redactValue(value, depth = 0) {
  if (depth > 12) return "[TRUNCATED]";
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(item => redactValue(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      /^(?:authorization|token|api[_-]?key|secret|password|private[_-]?key)$/i.test(key)
        ? "[REDACTED]"
        : redactValue(item, depth + 1)
    ]));
  }
  return value;
}

export function redactForExternalContext(messages = []) {
  return messages.map(message => ({
    ...message,
    content: redactSecrets(String(message.content || "")),
    ...(Array.isArray(message.images) ? { images: message.images } : {})
  }));
}
