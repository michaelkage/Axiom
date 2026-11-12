import { SessionSwitcher } from "./SessionSwitcher";
import { NewSessionButton } from "./NewSessionButton";
import type { Session } from "../types";
import type { SessionStatus } from "../state/types";
import type { AxiomTheme } from "../utils/theme";

interface TopBarProps {
  sessions: Session[];
  currentSessionId: string | null;
  currentSessionTitle: string;
  sessionStatus: (sessionId: string) => SessionStatus | null;
  onSessionSelect: (sessionId: string) => void;
  onNewSession: () => void;
  onRefreshSessions: () => Promise<void>;
  theme: AxiomTheme;
  accent: string;
  onThemeChange: (theme: AxiomTheme) => void;
  onAccentChange: (accent: string) => void;
}

export function TopBar(props: TopBarProps) {
  return (
    <div class="top-bar">
      <SessionSwitcher
        sessions={props.sessions}
        currentSessionId={props.currentSessionId}
        currentSessionTitle={props.currentSessionTitle}
        sessionStatus={props.sessionStatus}
        onSessionSelect={props.onSessionSelect}
        onRefreshSessions={props.onRefreshSessions}
      />
      <div class="top-bar__appearance" aria-label="Appearance settings">
        <label class="sr-only" for="axiom-theme">Color theme</label>
        <select id="axiom-theme" value={props.theme} onChange={(event) => props.onThemeChange(event.currentTarget.value as AxiomTheme)} aria-label="Color theme">
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          <option value="high-contrast">High contrast</option>
        </select>
        <label class="sr-only" for="axiom-accent">Accent color</label>
        <input id="axiom-accent" type="color" value={props.accent} onInput={(event) => props.onAccentChange(event.currentTarget.value)} aria-label="Accent color" title="Accent color" />
      </div>
      <NewSessionButton onClick={props.onNewSession} />
    </div>
  );
}
