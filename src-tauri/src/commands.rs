use std::path::PathBuf;
use std::sync::Arc;

use tauri::{AppHandle, State};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

use crate::error::{message, AppResult};
use crate::media_speed::media_url_host;
use crate::models::{
    AppSettings, AuthState, AuthorFollowRequest, AuthorFollowResult, DownloadDeleteRequest,
    DownloadResult, DownloadState, DownloadTask, DownloadVideoRequest, FavoriteFileResult,
    FavoriteImportResult, FavoriteState, IwaraVideoDiagnostics, ListVideoCommentsRequest,
    ListVideosRequest, LoginRequest, MediaSpeedTestReport, PartialAppSettings, PlayRequest,
    PlayResult, PlayerDiagnostics, PlayerProbe, SelectDirectoryRequest, SelectDirectoryResult,
    SelectExecutableRequest, SelectExecutableResult, SendVideoCommentRequest, VideoComment,
    VideoCommentsResult, VideoDetail, VideoListResult, VideoSummary, XVersionSaltReport,
};
use crate::state::AppState;

#[tauri::command]
pub async fn iwara_list_videos(
    state: State<'_, AppState>,
    request: ListVideosRequest,
) -> AppResult<VideoListResult> {
    let settings = state.settings.get();
    state
        .iwara_client
        .list_videos(request, settings.tag_preferences)
        .await
}

#[tauri::command]
pub async fn iwara_get_video(
    state: State<'_, AppState>,
    id_or_url: String,
) -> AppResult<VideoDetail> {
    maybe_sniff_x_version_salt(&state).await;
    let video = state.iwara_client.get_video(&id_or_url).await?;
    state.settings.add_media_hosts(
        video
            .formats
            .iter()
            .filter_map(|format| media_url_host(&format.url))
            .collect(),
    )?;
    let settings = state.settings.get();
    Ok(state
        .iwara_client
        .route_video_formats(video, &settings.media_speed))
}

#[tauri::command]
pub async fn iwara_diagnose_video(
    state: State<'_, AppState>,
    id_or_url: String,
) -> AppResult<IwaraVideoDiagnostics> {
    maybe_sniff_x_version_salt(&state).await;
    let network = state.session.capture_video_network(&id_or_url).await.ok();
    let report = state
        .iwara_client
        .diagnose_video(&id_or_url, network)
        .await?;
    let hosts = report
        .network
        .as_ref()
        .map(|network| {
            network
                .entries
                .iter()
                .flat_map(|entry| entry.formats.clone().unwrap_or_default())
                .filter_map(|format| media_url_host(&format.url))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    state.settings.add_media_hosts(hosts)?;
    Ok(report)
}

#[tauri::command]
pub async fn iwara_list_comments(
    state: State<'_, AppState>,
    request: ListVideoCommentsRequest,
) -> AppResult<VideoCommentsResult> {
    state
        .iwara_client
        .list_video_comments(&request.video_id)
        .await
}

#[tauri::command]
pub async fn iwara_send_comment(
    state: State<'_, AppState>,
    request: SendVideoCommentRequest,
) -> AppResult<VideoComment> {
    state.iwara_client.send_video_comment(request).await
}

#[tauri::command]
pub async fn iwara_set_author_following(
    state: State<'_, AppState>,
    request: AuthorFollowRequest,
) -> AppResult<AuthorFollowResult> {
    state.iwara_client.set_author_following(request).await
}

#[tauri::command]
pub async fn iwara_sniff_x_version_salt(
    state: State<'_, AppState>,
) -> AppResult<XVersionSaltReport> {
    let report = state.iwara_client.sniff_x_version_salt().await?;
    update_x_version_salt(&state, &report)?;
    Ok(report)
}

#[tauri::command]
pub async fn iwara_speed_test_video(
    state: State<'_, AppState>,
    id_or_url: String,
) -> AppResult<MediaSpeedTestReport> {
    let settings = state.settings.get();
    let report = state
        .iwara_client
        .speed_test_video(&id_or_url, &settings.media_speed)
        .await?;
    state
        .settings
        .update_media_host_ranking(&report.results, &report.tested_at)?;
    Ok(report)
}

#[tauri::command]
pub async fn iwara_download_video(
    state: State<'_, AppState>,
    request: DownloadVideoRequest,
) -> AppResult<DownloadResult> {
    maybe_sniff_x_version_salt(&state).await;
    let settings = state.settings.get();
    let result = state
        .iwara_client
        .download_video(request, &settings.download, &settings.media_speed)
        .await?;
    state.settings.add_media_hosts(
        result
            .video
            .formats
            .iter()
            .filter_map(|format| media_url_host(&format.url))
            .collect(),
    )?;
    state.downloads.complete(
        &format!("legacy-{}", crate::iwara_client::now_iso_string()),
        result.clone(),
    )?;
    Ok(result)
}

#[tauri::command]
pub fn downloads_list(state: State<'_, AppState>) -> DownloadState {
    state.downloads.state()
}

#[tauri::command]
pub async fn downloads_start(
    state: State<'_, AppState>,
    request: DownloadVideoRequest,
) -> AppResult<DownloadTask> {
    maybe_sniff_x_version_salt(&state).await;
    let request = normalize_download_request(&state, request);
    let start = state.downloads.start(request.clone());
    if start.is_new {
        spawn_download_task(&state, start.task.id.clone(), request);
    }
    Ok(start.task)
}

#[tauri::command]
pub async fn downloads_retry(state: State<'_, AppState>, id: String) -> AppResult<DownloadTask> {
    maybe_sniff_x_version_salt(&state).await;
    let request = normalize_download_request(&state, state.downloads.request_for_retry(&id)?);
    let start = state.downloads.start(request.clone());
    if start.is_new {
        spawn_download_task(&state, start.task.id.clone(), request);
    }
    Ok(start.task)
}

#[tauri::command]
pub async fn downloads_delete(
    state: State<'_, AppState>,
    request: DownloadDeleteRequest,
) -> AppResult<DownloadState> {
    state.downloads.delete(request).await
}

#[tauri::command]
pub fn downloads_open_file(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let path = download_task_path(&state, &id)?;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|err| message(err.to_string()))
}

#[tauri::command]
pub fn downloads_open_folder(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<()> {
    let path = PathBuf::from(download_task_path(&state, &id)?);
    let directory = if path.is_dir() {
        path
    } else {
        path.parent()
            .map(ToOwned::to_owned)
            .ok_or_else(|| message("下载文件没有可打开的文件夹。"))?
    };
    app.opener()
        .open_path(directory.to_string_lossy().to_string(), None::<&str>)
        .map_err(|err| message(err.to_string()))
}

#[tauri::command]
pub fn favorites_list(state: State<'_, AppState>) -> FavoriteState {
    state.favorites.state()
}

#[tauri::command]
pub fn favorites_add(state: State<'_, AppState>, video: VideoSummary) -> AppResult<FavoriteState> {
    state.favorites.add(video)
}

#[tauri::command]
pub fn favorites_remove(state: State<'_, AppState>, video_id: String) -> AppResult<FavoriteState> {
    state.favorites.remove(&video_id)
}

#[tauri::command]
pub fn favorites_backup(state: State<'_, AppState>) -> AppResult<FavoriteFileResult> {
    state.favorites.backup()
}

#[tauri::command]
pub async fn favorites_export(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<FavoriteFileResult> {
    let selected = app
        .dialog()
        .file()
        .set_title("导出收藏 JSON")
        .add_filter("JSON", &["json"])
        .add_filter("All Files", &["*"])
        .set_file_name("iwaratv-favorites.json")
        .blocking_save_file();
    let Some(path) = selected else {
        return Ok(FavoriteFileResult {
            canceled: true,
            path: None,
            count: state.favorites.state().items.len(),
        });
    };
    let mut path = path.into_path().map_err(|err| message(err.to_string()))?;
    if path.extension().is_none() {
        path.set_extension("json");
    }
    state.favorites.export_to_path(&path)
}

#[tauri::command]
pub async fn favorites_import(
    app: AppHandle,
    state: State<'_, AppState>,
) -> AppResult<FavoriteImportResult> {
    let selected = app
        .dialog()
        .file()
        .set_title("导入收藏 JSON")
        .add_filter("JSON", &["json"])
        .add_filter("All Files", &["*"])
        .blocking_pick_file();
    let Some(path) = selected else {
        let current = state.favorites.state();
        return Ok(FavoriteImportResult {
            canceled: true,
            path: None,
            imported: 0,
            merged: 0,
            skipped: 0,
            total: current.items.len(),
            state: current,
        });
    };
    let path = path.into_path().map_err(|err| message(err.to_string()))?;
    state.favorites.import_from_path(&path)
}

#[tauri::command]
pub async fn player_play(
    state: State<'_, AppState>,
    request: PlayRequest,
) -> AppResult<PlayResult> {
    state
        .player
        .play(&state.iwara_client, &state.settings, request)
        .await
}

#[tauri::command]
pub fn player_probe(state: State<'_, AppState>) -> PlayerDiagnostics {
    state.player.probe(&state.settings)
}

#[tauri::command]
pub fn player_test_mpv(state: State<'_, AppState>) -> PlayerProbe {
    state.player.test_mpv(&state.settings)
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> AppSettings {
    state.settings.get()
}

#[tauri::command]
pub fn settings_update(
    state: State<'_, AppState>,
    partial: PartialAppSettings,
) -> AppResult<AppSettings> {
    state.settings.update(partial)
}

#[tauri::command]
pub async fn auth_state(state: State<'_, AppState>) -> AppResult<AuthState> {
    merged_auth_state(&state).await
}

#[tauri::command]
pub async fn auth_login(state: State<'_, AppState>, request: LoginRequest) -> AppResult<AuthState> {
    state.iwara_client.login(request).await?;
    merged_auth_state(&state).await
}

#[tauri::command]
pub async fn auth_logout(state: State<'_, AppState>) -> AppResult<AuthState> {
    state.iwara_client.logout();
    merged_auth_state(&state).await
}

#[tauri::command]
pub async fn auth_open_iwara_session(state: State<'_, AppState>) -> AppResult<AuthState> {
    state.session.open_verification_window().await?;
    merged_auth_state(&state).await
}

#[tauri::command]
pub async fn system_select_executable(
    app: AppHandle,
    request: SelectExecutableRequest,
) -> AppResult<SelectExecutableResult> {
    let mut picker = app
        .dialog()
        .file()
        .set_title(request.title)
        .add_filter("Executable", &["exe", "cmd", "bat"])
        .add_filter("All Files", &["*"]);
    if let Some(current_path) = request.current_path {
        let current = std::path::PathBuf::from(current_path);
        if let Some(parent) = current.parent() {
            picker = picker.set_directory(parent);
        }
    }
    let selected = picker.blocking_pick_file();
    Ok(match selected {
        Some(path) => SelectExecutableResult {
            canceled: false,
            path: Some(
                path.into_path()
                    .map_err(|err| message(err.to_string()))?
                    .to_string_lossy()
                    .to_string(),
            ),
        },
        None => SelectExecutableResult {
            canceled: true,
            path: None,
        },
    })
}

#[tauri::command]
pub async fn system_select_directory(
    app: AppHandle,
    request: SelectDirectoryRequest,
) -> AppResult<SelectDirectoryResult> {
    let mut picker = app.dialog().file().set_title(request.title);
    if let Some(current_path) = request.current_path {
        let current = std::path::PathBuf::from(current_path);
        let directory = if current.is_dir() {
            current
        } else {
            current.parent().map(ToOwned::to_owned).unwrap_or(current)
        };
        picker = picker.set_directory(directory);
    }
    let selected = picker.blocking_pick_folder();
    Ok(match selected {
        Some(path) => SelectDirectoryResult {
            canceled: false,
            path: Some(
                path.into_path()
                    .map_err(|err| message(err.to_string()))?
                    .to_string_lossy()
                    .to_string(),
            ),
        },
        None => SelectDirectoryResult {
            canceled: true,
            path: None,
        },
    })
}

#[tauri::command]
pub fn system_open_external(app: AppHandle, url: String) -> AppResult<()> {
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|err| message(err.to_string()))
}

#[tauri::command]
pub fn system_write_clipboard(app: AppHandle, text: String) -> AppResult<()> {
    app.clipboard()
        .write_text(text)
        .map_err(|err| message(err.to_string()))
}

fn spawn_download_task(
    state: &State<'_, AppState>,
    task_id: String,
    request: DownloadVideoRequest,
) {
    let iwara_client = Arc::clone(&state.iwara_client);
    let settings_store = Arc::clone(&state.settings);
    let downloads = Arc::clone(&state.downloads);

    tokio::spawn(async move {
        let settings = settings_store.get();
        let result: AppResult<DownloadResult> = async {
            let plan = iwara_client
                .prepare_download(request, &settings.download, &settings.media_speed)
                .await?;
            downloads.mark_downloading(&task_id, &plan)?;
            let progress_downloads = Arc::clone(&downloads);
            let progress_task_id = task_id.clone();
            let bytes_written = iwara_client
                .download_plan_to_file(&plan, &settings.download, move |bytes, total| {
                    progress_downloads.update_progress(&progress_task_id, bytes, total);
                })
                .await?;
            let result = plan.clone().result(bytes_written);
            settings_store.add_media_hosts(
                result
                    .video
                    .formats
                    .iter()
                    .filter_map(|format| media_url_host(&format.url))
                    .collect(),
            )?;
            Ok(result)
        }
        .await;

        match result {
            Ok(result) => {
                let _ = downloads.complete(&task_id, result);
            }
            Err(err) => {
                let _ = downloads.fail(&task_id, err.to_string());
            }
        }
    });
}

fn download_task_path(state: &State<'_, AppState>, id: &str) -> AppResult<String> {
    state
        .downloads
        .task(id)
        .and_then(|task| task.path)
        .ok_or_else(|| message("下载记录没有可打开的文件路径。"))
}

fn normalize_download_request(
    state: &State<'_, AppState>,
    mut request: DownloadVideoRequest,
) -> DownloadVideoRequest {
    if request.quality.is_none() {
        request.quality = state.settings.get().download.default_quality;
    }
    request
}

async fn merged_auth_state(state: &State<'_, AppState>) -> AppResult<AuthState> {
    let base = state.iwara_client.auth_state();
    let session = state.session.state().await?;
    let mut username = base.username.clone().or_else(|| session.username.clone());
    let mut avatar_url = base
        .avatar_url
        .clone()
        .or_else(|| session.avatar_url.clone());
    if username.is_none() || avatar_url.is_none() {
        if let Ok(profile) = state.iwara_client.current_user_profile().await {
            if username.is_none() {
                username = profile.username;
            }
            if avatar_url.is_none() {
                avatar_url = profile.avatar_url;
            }
        }
    }
    Ok(AuthState {
        logged_in: base.logged_in,
        email: base.email.or(session.email),
        username,
        avatar_url,
        has_media_token: base.has_media_token,
        encryption_available: base.encryption_available,
        site_session_ready: session.site_session_ready,
        site_cookie_count: session.site_cookie_count,
        site_token_ready: session.site_token_ready,
        site_token_key: session.site_token_key,
        browser_user_agent: session.browser_user_agent,
        warning: base.warning.or(session.warning),
    })
}

async fn maybe_sniff_x_version_salt(state: &State<'_, AppState>) {
    let current = state.settings.get().iwara;
    if !current.auto_sniff_x_version_salt
        || is_fresh_iso_date(current.last_salt_sniff_at.as_deref(), 24 * 60 * 60)
    {
        return;
    }
    if let Ok(report) = state.iwara_client.sniff_x_version_salt().await {
        let _ = update_x_version_salt(state, &report);
    }
}

fn update_x_version_salt(
    state: &State<'_, AppState>,
    report: &XVersionSaltReport,
) -> AppResult<AppSettings> {
    let current = state.settings.get().iwara;
    state.settings.update(PartialAppSettings {
        iwara: Some(crate::models::PartialIwaraRuntimeSettings {
            x_version_salt: Some(report.salt.clone()),
            auto_sniff_x_version_salt: Some(current.auto_sniff_x_version_salt),
            last_salt_sniff_at: Some(Some(report.checked_at.clone())),
            last_salt_source: Some(Some(report.source_url.clone())),
        }),
        ..Default::default()
    })
}

fn is_fresh_iso_date(value: Option<&str>, max_age_seconds: i64) -> bool {
    let Some(value) = value else {
        return false;
    };
    let Ok(date) =
        time::OffsetDateTime::parse(value, &time::format_description::well_known::Rfc3339)
    else {
        return false;
    };
    (time::OffsetDateTime::now_utc() - date).whole_seconds() < max_age_seconds
}
