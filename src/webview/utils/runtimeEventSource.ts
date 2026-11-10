type SSEEventHandler = (data: string) => void;
type SSEErrorHandler = (error: Error) => void;
type SSEStatusHandler = (status: {
  status: "connecting" | "connected" | "reconnecting" | "closed";
  attempt?: number;
  nextRetryMs?: number;
  reason?: "aborted" | "error" | "manual";
}) => void;

/** Subscribe directly from the standalone renderer to the local OpenCode runtime. */
export function runtimeEventSource(url: string, onMessage: SSEEventHandler, onError?: SSEErrorHandler, onStatus?: SSEStatusHandler): () => void {
  const eventSource = new EventSource(url);
  onStatus?.({ status: "connecting" });
  eventSource.onopen = () => onStatus?.({ status: "connected" });
  eventSource.onmessage = event => onMessage(event.data);
  eventSource.onerror = () => {
    onStatus?.({ status: "reconnecting", reason: "error" });
    onError?.(new Error("EventSource connection error"));
  };
  return () => { eventSource.close(); onStatus?.({ status: "closed", reason: "manual" }); };
}
