export type RecoveryKind = "connection" | "timeout" | "rate-limit" | "local-model" | "tool" | "permission" | "unknown";
export interface RecoveryAdvice { kind: RecoveryKind; title: string; explanation: string; retryable: boolean; safeToRetryAutomatically: boolean; }

/** Redact common credential formats before diagnostics cross a trust boundary. */
export function redactDiagnostic(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value ?? "");
  return message
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\b\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/gi, "[REDACTED_TOKEN]")
    .replace(/(https?:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[REDACTED]@");
}

export function classifyRecovery(error: unknown): RecoveryAdvice {
  const message = redactDiagnostic(error);
  const text = message.toLowerCase();
  if (/permission|not authorized|forbidden|approval required|insufficient permissions/.test(text))
    return { kind: "permission", title: "Permission needed", explanation: "Review the requested permission and approve it if you trust the action. If this is a provider access error, check the provider account and model permissions too.", retryable: true, safeToRetryAutomatically: false };
  if (/api.?key|invalid.?key|missing.?credential|no credentials|authentication required|unauthenticated|401|unauthorized|invalid token|expired token/.test(text))
    return { kind: "connection", title: "Provider sign-in or credentials needed", explanation: "The runtime responded, but the provider did not accept the request. Complete the provider's sign-in or API-key setup, confirm the key belongs to the expected account, and check that the account can access the selected model. Do not paste secrets into prompts or issue reports.", retryable: true, safeToRetryAutomatically: false };
  if (/model.*(not found|unavailable|does not exist)|unknown model|unsupported model|no model configured|provider.*not configured|model.*not.*available/.test(text))
    return { kind: "local-model", title: "Model unavailable or not configured", explanation: "Confirm the selected model ID exists for the chosen provider. For a local provider, start its server and verify the model is downloaded and exposed at the configured endpoint. Some models do not support tool calling.", retryable: true, safeToRetryAutomatically: false };
  if (/quota|insufficient.*credit|billing|payment required|credit balance/.test(text))
    return { kind: "rate-limit", title: "Provider quota or billing issue", explanation: "Check the provider's usage, billing, and quota status. Waiting alone may not resolve an account or billing restriction.", retryable: false, safeToRetryAutomatically: false };
  if (/429|rate.?limit|too many requests/.test(text))
    return { kind: "rate-limit", title: "Rate limit reached", explanation: "Wait briefly, then retry. A provider or gateway may be throttling requests.", retryable: true, safeToRetryAutomatically: true };
  if (/timeout|timed out|etimedout|deadline exceeded|aborted/.test(text))
    return { kind: "timeout", title: "Request timed out", explanation: "The model or tool took too long. Retry once, or reduce the task scope.", retryable: true, safeToRetryAutomatically: true };
  if (/econnrefused|fetch failed|network|socket|connection reset|not connected|failed to connect|connection refused|enotfound/.test(text))
    return { kind: "connection", title: "Runtime or provider connection problem", explanation: "First distinguish the local Axiom runtime from the model provider: if Axiom itself is reconnecting, check the runtime log; if the runtime is available but model requests fail, check internet access, provider status, credentials, or the local model server. Retry after the failing service is reachable.", retryable: true, safeToRetryAutomatically: true };
  if (/ollama|lm studio|local model|context length|invalid json|schema|malformed response|no choices|structured output/.test(text))
    return { kind: "local-model", title: "Model response could not be used", explanation: "Try again with a shorter prompt or select a model with compatible tool and structured-output support.", retryable: true, safeToRetryAutomatically: false };
  if (/tool|command|exit code|spawn|enoent|compile|syntax error/.test(text))
    return { kind: "tool", title: "Tool or command failed", explanation: "Inspect the command output before retrying. A repeated run may have side effects.", retryable: true, safeToRetryAutomatically: false };
  return { kind: "unknown", title: "Request failed", explanation: "Review the error details before retrying; no automatic retry was attempted.", retryable: false, safeToRetryAutomatically: false };
}
