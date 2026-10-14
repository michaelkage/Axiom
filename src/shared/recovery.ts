export type RecoveryKind = "connection" | "timeout" | "rate-limit" | "local-model" | "tool" | "permission" | "unknown";
export interface RecoveryAdvice { kind: RecoveryKind; title: string; explanation: string; retryable: boolean; safeToRetryAutomatically: boolean; }
export function classifyRecovery(error: unknown): RecoveryAdvice {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const text = message.toLowerCase();
  if (/permission|not authorized|forbidden|approval required/.test(text))
    return { kind: "permission", title: "Permission needed", explanation: "Review the requested permission and approve it if you trust the action.", retryable: true, safeToRetryAutomatically: false };
  if (/429|rate.?limit|too many requests/.test(text))
    return { kind: "rate-limit", title: "Rate limit reached", explanation: "Wait briefly, then retry. A provider or gateway may be throttling requests.", retryable: true, safeToRetryAutomatically: true };
  if (/timeout|timed out|etimedout|deadline exceeded/.test(text))
    return { kind: "timeout", title: "Request timed out", explanation: "The model or tool took too long. Retry once, or reduce the task scope.", retryable: true, safeToRetryAutomatically: true };
  if (/econnrefused|fetch failed|network|socket|connection reset|not connected/.test(text))
    return { kind: "connection", title: "Connection problem", explanation: "Check that the local runtime or model gateway is running and reachable, then retry.", retryable: true, safeToRetryAutomatically: true };
  if (/ollama|lm studio|local model|context length|invalid json|schema|malformed response|no choices/.test(text))
    return { kind: "local-model", title: "Model response could not be used", explanation: "Try again with a shorter prompt or select a model with compatible tool and structured-output support.", retryable: true, safeToRetryAutomatically: false };
  if (/tool|command|exit code|spawn|enoent|compile|syntax error/.test(text))
    return { kind: "tool", title: "Tool or command failed", explanation: "Inspect the command output before retrying. A repeated run may have side effects.", retryable: true, safeToRetryAutomatically: false };
  return { kind: "unknown", title: "Request failed", explanation: "Review the error details before retrying; no automatic retry was attempted.", retryable: false, safeToRetryAutomatically: false };
}
