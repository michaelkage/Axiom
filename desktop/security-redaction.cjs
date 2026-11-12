"use strict";

const PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:sb_secret_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b/g,
  /(authorization\s*[:=]\s*)(?:bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi,
  /((?:api[_-]?key|token|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret|private[_-]?key)\s*[:=]\s*)(["']?)[^\s"'&,;]+\2/gi,
  /(^|\n)([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=)([^\r\n]*)/g
];

function redactSecrets(value) {
  let output = String(value ?? "");
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, (...args) => {
      const source = pattern.source;
      if (source.startsWith("(authorization")) return args[1] + "[REDACTED]";
      if (source.startsWith("((?:api")) return args[1] + "[REDACTED]";
      if (source.startsWith("(^|")) return args[1] + args[2] + "[REDACTED]";
      return "[REDACTED]";
    });
  }
  return output;
}

module.exports = { redactSecrets };
