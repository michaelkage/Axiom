import { createSignal, Show, For, onCleanup } from "solid-js";
import type { Session } from "../types";
import type { SessionStatus } from "../state/types";

interface SessionSwitcherProps {
  sessions: Session[];
  currentSessionId: string | null;
  currentSessionTitle: string;
  sessionStatus: (sessionId: string) => SessionStatus | null;
  onSessionSelect: (sessionId: string) => void;
  onRefreshSessions: () => Promise<void>;
}

export function SessionSwitcher(props: SessionSwitcherProps) {
  const [isOpen, setIsOpen] = createSignal(false);
  const [isLoading, setIsLoading] = createSignal(false);
  const [refreshFailed, setRefreshFailed] = createSignal(false);
  const [spinnerFrame, setSpinnerFrame] = createSignal(0);

  const spinnerFrames = ["\\\\", "|", "/", "-"];

  const spinnerInterval = setInterval(() => {
    setSpinnerFrame((prev) => (prev + 1) % spinnerFrames.length);
  }, 150);

  onCleanup(() => clearInterval(spinnerInterval));

  const refreshSessions = async () => {
    setIsLoading(true);
    setRefreshFailed(false);
    try {
      await props.onRefreshSessions();
    } catch {
      setRefreshFailed(true);
    } finally {
      setIsLoading(false);
    }
  };

  const toggleDropdown = () => {
    const shouldOpen = !isOpen();
    setIsOpen(shouldOpen);

    if (shouldOpen) void refreshSessions();
  };

  const handleSessionClick = (sessionId: string) => {
    props.onSessionSelect(sessionId);
    setIsOpen(false);
  };

  const formatRelativeTime = (timestamp: number): string => {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    if (minutes > 0) return `${minutes}m ago`;
    return "just now";
  };

  return (
    <div class="session-switcher">
      <button
        type="button"
        class={`session-switcher-button ${isOpen() ? "active" : ""}`}
        onClick={toggleDropdown}
        aria-label="Switch session"
        aria-expanded={isOpen()}
      >
        <span class="session-title">{props.currentSessionTitle}</span>
      </button>

      <Show when={isOpen()}>
        <div class="session-dropdown">
          <Show when={isLoading()}>
            <div class="session-loading" role="status">Loading sessions...</div>
          </Show>
          <Show when={!isLoading() && refreshFailed()}>
            <div class="session-loading" role="alert">
              Couldn't load sessions.
              <button type="button" onClick={() => void refreshSessions()}>Retry</button>
            </div>
          </Show>
          <Show when={!isLoading() && !refreshFailed()}>
            <Show
              when={props.sessions.length > 0}
              fallback={<div class="session-loading">No sessions found</div>}
            >
              <For each={props.sessions}>
                {(session) => {
                  const status = () => props.sessionStatus(session.id);
                  const isBusy = () => status()?.type === "busy";

                  return (
                    <button
                      type="button"
                      class={`session-item ${session.id === props.currentSessionId ? "current" : ""}`}
                      aria-current={session.id === props.currentSessionId ? "true" : undefined}
                      onClick={() => handleSessionClick(session.id)}
                    >
                      <span class="session-item-title">
                        <Show when={isBusy()}>
                          <span class="loading-indicator session-status-indicator" aria-label="Session busy">
                            {spinnerFrames[spinnerFrame()]}
                          </span>
                        </Show>
                        {session.title}
                      </span>
                      <span class="session-item-time">{formatRelativeTime(session.time.updated)}</span>
                    </button>
                  );
                }}
              </For>
            </Show>
          </Show>
        </div>
      </Show>
    </div>
  );
}
