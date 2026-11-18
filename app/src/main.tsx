import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ToastProvider } from "./components/ui/toast";
import { applyTheme } from "./lib/theme";
import "./index.css";

applyTheme();

document.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement | null;
  if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.closest(".cm-editor"))) e.preventDefault();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </React.StrictMode>,
);

requestAnimationFrame(() => {
  const win = getCurrentWindow();
  win.show().then(() => win.unminimize()).then(() => win.setFocus());
});
