/** Use the standalone renderer's native fetch implementation. The old extension-host proxy
 * is intentionally gone because Axiom now runs as a standalone Electron app. */
export function proxyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}
