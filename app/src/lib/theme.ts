import type { ThemeMode } from "@/lib/api";

export type { ThemeMode };

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(mode: ThemeMode) {
  const dark = mode === "dark" || (mode === "system" && media().matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Follows macOS while the mode is "system". */
export function watchSystemTheme(mode: ThemeMode): () => void {
  const query = media();
  const onChange = () => applyTheme(mode);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
