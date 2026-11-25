import { useEffect, useState } from "react";
import { z } from "zod";
import { useMediaQuery } from "./useMediaQuery";

// One choice per browser: follow the system (default), light or dark. Light is
// the Journal palette and dark is Graphite. Palette choices saved by older
// versions (litscout-light, litscout-dark) are ignored; the mode survives.
const schema = z.object({
  mode: z.enum(["system", "light", "dark"]).catch("system"),
});
export type ThemePrefs = z.infer<typeof schema>;
export type ThemeMode = ThemePrefs["mode"];
export type ThemeName = "journal" | "graphite";

export function readTheme(storage: Pick<Storage, "getItem">): ThemePrefs {
  try {
    return schema.parse({ mode: storage.getItem("litscout-mode") });
  } catch {
    return schema.parse({});
  }
}
export function resolveTheme(p: ThemePrefs, systemDark: boolean): ThemeName {
  return p.mode === "dark" || (p.mode === "system" && systemDark)
    ? "graphite"
    : "journal";
}
export { topicColour, applyTopicColour } from "./topic-colours";
export function useTheme() {
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const [prefs, setPrefs] = useState(() => {
    try {
      return readTheme(localStorage);
    } catch {
      return schema.parse({});
    }
  });
  const activeTheme = resolveTheme(prefs, systemDark);
  useEffect(() => {
    document.documentElement.dataset.theme = activeTheme;
  }, [activeTheme]);
  useEffect(() => {
    try {
      localStorage.setItem("litscout-mode", prefs.mode);
      // Drop the palette keys older versions wrote.
      localStorage.removeItem("litscout-light");
      localStorage.removeItem("litscout-dark");
    } catch {
      /* Reading remains available when storage is disabled. */
    }
  }, [prefs]);
  return { prefs, setPrefs, theme: activeTheme };
}
