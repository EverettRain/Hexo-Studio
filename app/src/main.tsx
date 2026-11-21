import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/ui/toast";
import { loadPreferences, PreferencesProvider } from "./lib/preferences";
import { applyTheme } from "./lib/theme";
import "./index.css";

document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.closest(".cm-editor"))) e.preventDefault();
});

// The window is shown after the first frame, which waits for the preferences (its colours).
void loadPreferences().then((boot) => {
  applyTheme(boot.ui.mode);
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <PreferencesProvider initial={boot}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </PreferencesProvider>
    </React.StrictMode>,
  );
  requestAnimationFrame(() => {
    const win = getCurrentWindow();
    win.show().then(() => win.unminimize()).then(() => win.setFocus());
  });
});
