import type { ThemeMode } from "@/lib/api";

export type { ThemeMode };

export interface Theme {
  id: string;
  name: string;
  description: string;
}

/** The interface's themes; each one's variables are in index.css under `[data-theme="<id>"]`. */
export const THEMES: Theme[] = [{ id: "default", name: "默认", description: "圆角卡片、柔和阴影，石墨灰配靛蓝。" }];

export const themeOf = (id: string): Theme => THEMES.find((t) => t.id === id) ?? THEMES[0];

const media = () => window.matchMedia("(prefers-color-scheme: dark)");

export function applyTheme(mode: ThemeMode, theme: string) {
  document.documentElement.dataset.theme = themeOf(theme).id;
  const dark = mode === "dark" || (mode === "system" && media().matches);
  document.documentElement.classList.toggle("dark", dark);
}

/** Follows macOS while the mode is "system". */
export function watchSystemTheme(mode: ThemeMode, theme: string): () => void {
  const query = media();
  const onChange = () => applyTheme(mode, theme);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
