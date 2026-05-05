mod auth;
mod commands;
mod error;
mod iwara_client;
mod iwara_utils;
mod media_speed;
mod models;
mod player;
mod player_template;
mod session;
mod settings;
mod state;

use tauri::{Manager, Runtime, WindowEvent};

const MAIN_WINDOW_LABEL: &str = "main";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let state = state::AppState::new(app.handle().clone())?;
            app.manage(state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == MAIN_WINDOW_LABEL
                && matches!(event, WindowEvent::CloseRequested { .. })
            {
                close_auxiliary_webview_windows(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::iwara_list_videos,
            commands::iwara_get_video,
            commands::iwara_diagnose_video,
            commands::iwara_list_comments,
            commands::iwara_send_comment,
            commands::iwara_set_author_following,
            commands::iwara_sniff_x_version_salt,
            commands::iwara_speed_test_video,
            commands::iwara_download_video,
            commands::player_play,
            commands::player_probe,
            commands::player_test_mpv,
            commands::settings_get,
            commands::settings_update,
            commands::auth_state,
            commands::auth_login,
            commands::auth_logout,
            commands::auth_open_iwara_session,
            commands::system_select_executable,
            commands::system_select_directory,
            commands::system_open_external,
            commands::system_write_clipboard
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn close_auxiliary_webview_windows<R: Runtime>(app: &tauri::AppHandle<R>) {
    for (label, window) in app.webview_windows() {
        if label != MAIN_WINDOW_LABEL {
            let _ = window.close();
        }
    }
}
