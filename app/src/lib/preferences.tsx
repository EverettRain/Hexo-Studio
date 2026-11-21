import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type ThemeMode, type UiPreferences, type UserView } from "@/lib/api";
import { applyTheme, watchSystemTheme } from "@/lib/theme";

export const DEFAULT_UI: UiPreferences = { mode: "system", previewShare: null, webStorageMigrated: true };

/** Where the interface kept these before preferences existed. */
export const WEB_STORAGE_KEYS = { mode: "hexo-studio.theme", previewShare: "hexo-studio.preview-width" } as const;

const MODES: ThemeMode[] = ["system", "light", "dark"];

/** Brings over what the WebView's storage held, once; `read` is that storage's getter. */
export function fromWebStorage(ui: UiPreferences, read: (key: string) => string | null): UiPreferences {
  if (ui.webStorageMigrated) return ui;
  const mode = read(WEB_STORAGE_KEYS.mode) as ThemeMode | null;
  const share = Number(read(WEB_STORAGE_KEYS.previewShare));
  return {
    ...ui,
    mode: mode && MODES.includes(mode) ? mode : ui.mode,
    previewShare: share >= 0.2 && share <= 0.8 ? share : ui.previewShare,
    webStorageMigrated: true,
  };
}

export interface Boot {
  ui: UiPreferences;
  user: UserView | null;
}

/** Read before the first frame, so the window never shows the wrong colours. */
export async function loadPreferences(): Promise<Boot> {
  const [saved, user] = await Promise.all([api.uiPreferences().catch(() => DEFAULT_UI), api.userProfile().catch(() => null)]);
  let ui = saved;
  if (!saved.webStorageMigrated) {
    const storage = (() => {
      try {
        return window.localStorage;
      } catch {
        return null;
      }
    })();
    ui = fromWebStorage(saved, (k) => storage?.getItem(k) ?? null);
    await api.saveUiPreferences(ui).catch(() => {});
    Object.values(WEB_STORAGE_KEYS).forEach((k) => storage?.removeItem(k));
  }
  return { ui, user };
}

interface PreferencesValue {
  ui: UiPreferences;
  update: (patch: Partial<UiPreferences>) => void;
  user: UserView | null;
  setUser: (user: UserView) => void;
}

const Ctx = createContext<PreferencesValue | null>(null);

export function PreferencesProvider({ initial, children }: { initial: Boot; children: ReactNode }) {
  const [ui, setUi] = useState(initial.ui);
  const [user, setUser] = useState(initial.user);
  const latest = useRef(ui);

  const update = useCallback((patch: Partial<UiPreferences>) => {
    const next = { ...latest.current, ...patch };
    latest.current = next;
    setUi(next);
    void api.saveUiPreferences(next).catch(() => {});
  }, []);

  useEffect(() => {
    applyTheme(ui.mode);
    return watchSystemTheme(ui.mode);
  }, [ui.mode]);

  const value = useMemo(() => ({ ui, update, user, setUser }), [ui, update, user]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePreferences(): PreferencesValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("usePreferences outside PreferencesProvider");
  return v;
}

/** The light / dark mode from the user's preferences, and how to change it. */
export function useTheme() {
  const { ui, update } = usePreferences();
  return [ui.mode, (mode: ThemeMode) => update({ mode })] as const;
}
