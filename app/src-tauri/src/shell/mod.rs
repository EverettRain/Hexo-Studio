//! The Tauri application: plugins, window, commands and the events sent to the page.

mod commands;
mod window;

use crate::service::preview::{Preview, PreviewEvent};
use crate::service::runner::{RunEvent, Runner};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};

fn run_sink(app: AppHandle) -> impl Fn(RunEvent) + Send + Sync + 'static {
    #[derive(Clone, serde::Serialize)]
    #[serde(rename_all = "camelCase")]
    struct Line {
        run: u64,
        line: crate::service::runner::RunLine,
    }
    move |e| {
        let _ = match e {
            RunEvent::Started(r) => app.emit("run-started", r),
            RunEvent::Line { run, line } => app.emit("run-line", Line { run, line }),
            RunEvent::Finished(r) => app.emit("run-finished", r),
        };
    }
}

fn preview_sink(app: AppHandle) -> impl Fn(PreviewEvent) + Send + Sync + 'static {
    move |e| {
        let _ = match e {
            PreviewEvent::State(s) => app.emit("preview-state", s),
            PreviewEvent::Log(l) => app.emit("preview-log", l),
        };
    }
}

/// `kill` and Ctrl-C would otherwise end the process without `RunEvent::Exit`, leaving the
/// `hexo server` behind (it is in its own process group). The pid file in `.hexostudio/local/`
/// still covers a hard kill or a crash.
fn quit_on_signals(app: AppHandle) {
    use signal_hook::consts::{SIGHUP, SIGINT, SIGTERM};
    match signal_hook::iterator::Signals::new([SIGTERM, SIGINT, SIGHUP]) {
        Ok(mut signals) => {
            std::thread::spawn(move || {
                if signals.forever().next().is_some() {
                    app.exit(0);
                }
            });
        }
        Err(e) => crate::infra::paths::log(&format!("无法监听退出信号：{e}")),
    }
}

pub fn run() {
    crate::infra::install_tls();
    tauri::Builder::default()
        // Must come first: a second launch only brings up the running instance's window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::show_main(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::restart_app,
            commands::recent_projects,
            commands::open_project,
            commands::close_project,
            commands::forget_project,
            commands::reveal_project,
            commands::blog_status,
            commands::set_node_path,
            commands::list_posts,
            commands::read_post,
            commands::write_post,
            commands::reveal_post,
            commands::open_post_externally,
            commands::preview_start,
            commands::preview_restart,
            commands::preview_stop,
            commands::preview_state,
            commands::preview_log,
            commands::preview_probe,
            commands::preview_await_change,
            commands::blog_git_changes,
            commands::config_read,
            commands::config_write,
            commands::list_plugins,
            commands::data_files,
            commands::data_read,
            commands::data_write,
            commands::source_status,
            commands::source_commits,
            commands::source_commit_detail,
            commands::source_commit,
            commands::source_push,
            commands::source_pull,
            commands::run_task,
            commands::run_task_and_wait,
            commands::cancel_run,
            commands::list_runs,
            commands::open_url,
            commands::storage_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::activate_profile,
            commands::save_library_settings,
            commands::check_storage,
            commands::upload_image_file,
            commands::upload_image_bytes,
            commands::image_library,
            commands::update_image,
            commands::delete_image,
            commands::check_images,
            commands::reveal_path,
            commands::adoption_plan,
            commands::run_adoption,
            commands::import_checklist,
            commands::export_checklist,
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            quit_on_signals(handle.clone());
            let preview = Preview::new(preview_sink(handle.clone()));
            app.manage(Runner::new(preview.clone(), run_sink(handle.clone())));
            app.manage(preview);
            app.manage(commands::Workspace::default());
            window::show_main(&handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Hexo-Studio")
        .run(|app, event| match event {
            // Clicking the Dock icon reaches the running instance as a reopen request.
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => window::show_main(app),
            // No `hexo server` outlives the app.
            tauri::RunEvent::Exit => {
                if let Some(r) = app.try_state::<Arc<Runner>>() {
                    r.cancel();
                }
                if let Some(p) = app.try_state::<Arc<Preview>>() {
                    p.stop();
                }
            }
            _ => {}
        });
}
