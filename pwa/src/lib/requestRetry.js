const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function retryDelay(response, attempt, baseDelayMs, maxDelayMs) {
  const retryAfter = response?.headers?.get?.('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const dateDelay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay >= 0) return Math.min(maxDelayMs, dateDelay);
  }
  return Math.min(maxDelayMs, baseDelayMs * (2 ** Math.max(0, attempt - 1)));
}

function abortError(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Operation aborted', 'AbortError');
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    abortError(signal);
    const timer = setTimeout(done, ms);
    function done() { signal?.removeEventListener('abort', aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal.reason || new DOMException('Operation aborted', 'AbortError')); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

/**
 * Retry a request only before a response body is consumed. Callers must invoke
 * this around fetch itself, never around stream parsing or non-idempotent work.
 */
export async function requestWithRetry(fetchImpl, input, init = {}, {
  retries = 2,
  baseDelayMs = 400,
  maxDelayMs = 4000,
  signal = init.signal,
  onRetry = () => {}
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const retryCount = Math.max(0, Math.min(5, Number.isInteger(retries) ? retries : 2));
  for (let attempt = 0; ; attempt += 1) {
    abortError(signal);
    try {
      const response = await fetchImpl(input, { ...init, signal });
      if (!response || !Number.isInteger(response.status)) throw new Error('fetchImpl did not return a valid HTTP response.');
      if (!RETRYABLE_STATUS.has(response.status) || attempt >= retryCount) return response;
      const delayMs = retryDelay(response, attempt + 1, baseDelayMs, maxDelayMs);
      try { await response.body?.cancel?.(); } catch { /* Response may not expose a cancellable body. */ }
      onRetry({ attempt: attempt + 1, maxAttempts: retryCount + 1, status: response.status, delayMs });
      await wait(delayMs, signal);
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      if (attempt >= retryCount || !(error instanceof TypeError)) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** attempt));
      onRetry({ attempt: attempt + 1, maxAttempts: retryCount + 1, status: null, delayMs, error: error.message });
      await wait(delayMs, signal);
    }
  }
}
