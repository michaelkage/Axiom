import { describe, expect, it } from "vitest";
import { DEFAULT_THEME_PREFERENCES, loadThemePreferences } from "./theme";

describe("desktop theme preferences", () => {
  it("provides a stable dark default", () => {
    expect(DEFAULT_THEME_PREFERENCES).toEqual({ theme: "dark", accent: "#0e639c" });
  });
  it("falls back safely when storage is unavailable", () => {
    expect(loadThemePreferences()).toEqual(DEFAULT_THEME_PREFERENCES);
  });
});
