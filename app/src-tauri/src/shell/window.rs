//! The main window, with the macOS title bar drawn by the page.

use tauri::{AppHandle, Manager, WebviewWindowBuilder};

pub const MAIN: &str = "main";

/// Runs inside the preview frame (a page of the local `hexo server`): keeps the scroll position
/// per page in that origin's session storage, so reloading the frame after a save returns to
/// the same place. The frame is cross-origin to the app, which cannot read its scroll itself.
const PREVIEW_SCROLL_SCRIPT: &str = r#"
(function () {
  if (window.top === window || location.hostname !== "127.0.0.1") return;
  var key = "hexo-studio.scroll:" + location.pathname;
  var target = Number(sessionStorage.getItem(key) || 0);
  // The theme keeps moving content while images and fonts load, so the position is applied
  // again for a while, until the reader scrolls themselves.
  var settling = target > 0;
  var stopSettling = function () { settling = false; };
  ["wheel", "touchstart", "keydown", "mousedown"].forEach(function (t) {
    window.addEventListener(t, stopSettling, { passive: true, capture: true });
  });
  var restore = function () { if (settling) window.scrollTo(0, target); };
  [0, 150, 400, 900, 1600].forEach(function (ms) {
    window.addEventListener("DOMContentLoaded", function () { setTimeout(restore, ms); });
  });
  window.addEventListener("load", restore);
  setTimeout(stopSettling, 2500);
  var saving = null;
  window.addEventListener("scroll", function () {
    if (settling) return;
    clearTimeout(saving);
    saving = setTimeout(function () { sessionStorage.setItem(key, String(window.scrollY)); }, 120);
  }, { passive: true });
})();
"#;

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let Some(cfg) = app.config().app.windows.iter().find(|w| w.label == MAIN).cloned() else { return };
    let Ok(builder) = WebviewWindowBuilder::from_config(app, &cfg) else { return };
    let builder = builder.initialization_script_for_all_frames(PREVIEW_SCROLL_SCRIPT);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        // Vertically centre the traffic lights on the 48px sidebar header row.
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 22.0));
    if let Err(e) = builder.build() {
        crate::infra::paths::log(&format!("无法创建窗口：{e}"));
        return;
    }
    // The page shows the window once it has painted; if that never comes (a broken WebView),
    // show it anyway rather than leave an invisible window behind.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(1500));
        if let Some(w) = app.get_webview_window(MAIN) {
            if !w.is_visible().unwrap_or(true) {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }
    });
}
