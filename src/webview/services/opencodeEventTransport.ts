import { runtimeEventSource } from "../utils/runtimeEventSource";

export interface RuntimeEventStatus {
  status: "connecting" | "connected" | "reconnecting" | "closed";
  attempt?: number;
  nextRetryMs?: number;
  reason?: "aborted" | "error" | "manual";
}
export type RuntimeEventSubscriber<TEvent> = (
  onEvent: (event: TEvent) => void,
  onStatus?: (status: RuntimeEventStatus) => void,
  directoryOverride?: string,
) => () => void;

/** Creates a typed OpenCode event subscription over the standalone renderer SSE transport. */
export function createOpenCodeEventSubscriber<TEvent>(
  getConnection: () => { serverUrl?: string; workspaceRoot?: string },
  openStream: typeof runtimeEventSource = runtimeEventSource,
  reportError: (message: string, error?: unknown) => void = (message, error) => console.error(message, error),
): RuntimeEventSubscriber<TEvent> {
  return (onEvent, onStatus, directoryOverride) => {
    const connection = getConnection();
    if (!connection.serverUrl) throw new Error("Not connected to the OpenCode runtime.");
    const url = new URL("/event", connection.serverUrl);
    const directory = directoryOverride ?? connection.workspaceRoot;
    if (directory) url.searchParams.set("directory", directory);
    return openStream(
      url.toString(),
      data => {
        try {
          onEvent(JSON.parse(data) as TEvent);
        } catch (error) {
          reportError("[SSE] Failed to parse runtime event.", error);
        }
      },
      error => reportError("[SSE] EventSource error.", error),
      onStatus,
    );
  };
}
