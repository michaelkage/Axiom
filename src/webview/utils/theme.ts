export type AxiomTheme = "light" | "dark" | "high-contrast";
export interface ThemePreferences { theme: AxiomTheme; accent: string }
const STORAGE_KEY = "axiom.desktop.appearance.v1";
export const DEFAULT_THEME_PREFERENCES: ThemePreferences = { theme: "dark", accent: "#0e639c" };

function validAccent(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

export function loadThemePreferences(): ThemePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    return {
      theme: value?.theme === "light" || value?.theme === "high-contrast" ? value.theme : "dark",
      accent: validAccent(value?.accent) ? value.accent : DEFAULT_THEME_PREFERENCES.accent
    };
  } catch {
    return { ...DEFAULT_THEME_PREFERENCES };
  }
}

function foregroundForAccent(accent: string): string {
  const channels = accent.slice(1).match(/.{2}/g)!.map(value => parseInt(value, 16) / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
  return luminance > 0.42 ? "#101010" : "#ffffff";
}

export function applyThemePreferences(preferences: ThemePreferences): void {
  if (typeof document === "undefined") return;
  const theme: AxiomTheme = preferences.theme === "light" || preferences.theme === "high-contrast" ? preferences.theme : "dark";
  const accent = validAccent(preferences.accent) ? preferences.accent : DEFAULT_THEME_PREFERENCES.accent;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.style.colorScheme = theme === "light" ? "light" : "dark";
  root.style.setProperty("--axiom-accent", accent);
  root.style.setProperty("--button-background", accent);
  root.style.setProperty("--focus-border", accent);
  root.style.setProperty("--text-link-foreground", accent);
  root.style.setProperty("--text-link-active-foreground", accent);
  root.style.setProperty("--button-foreground", foregroundForAccent(accent));
}

export function saveThemePreferences(preferences: ThemePreferences): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* Theme still applies for this session. */ }
}
