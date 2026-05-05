use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::time::sleep;

use crate::error::{message, AppResult};
use crate::iwara_client::IwaraClient;
use crate::iwara_utils::choose_video_format;
use crate::media_speed::media_url_host;
use crate::models::{PlayRequest, PlayResult, PlayerDiagnostics, PlayerMode, PlayerProbe};
use crate::player_template::{
    build_external_player_args, template_includes_url, PlayerTemplateValues,
};
use crate::settings::{to_summary, SettingsStore};

const HTTP_HEADERS_TEMPLATE: &str = "Referer: https://www.iwara.tv/";

pub struct PlayerService {
    app: AppHandle,
}

impl PlayerService {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    pub fn probe(&self, settings_store: &SettingsStore) -> PlayerDiagnostics {
        let settings = settings_store.get();
        let configured_mpv_path = settings.player.mpv_path.clone();
        let mpv_path = self.resolve_mpv_path(configured_mpv_path.as_deref());
        let external_path = settings.player.external_player_path.clone();
        let mut external_args_preview = Vec::new();
        let mut external_template_has_url = false;
        let mut template_error: Option<String> = None;

        match template_includes_url(&settings.player.external_player_args) {
            Ok(value) => external_template_has_url = value,
            Err(err) => template_error = Some(err.to_string()),
        }
        if template_error.is_none() {
            match build_external_player_args(
                &settings.player.external_player_args,
                &PlayerTemplateValues {
                    url: "https://media.example/video.mp4",
                    title: "IwaraTV Preview",
                    headers: HTTP_HEADERS_TEMPLATE,
                },
            ) {
                Ok(args) => external_args_preview = args,
                Err(err) => template_error = Some(err.to_string()),
            }
        }

        let external_exists = external_path
            .as_deref()
            .map(|path| Path::new(path).exists())
            .unwrap_or(false);
        PlayerDiagnostics {
            mpv: PlayerProbe {
                ok: mpv_path.is_some(),
                label: "MPV".to_string(),
                configured_path: configured_mpv_path.clone(),
                resolved_path: mpv_path.map(path_to_string),
                message: self
                    .resolve_mpv_path(configured_mpv_path.as_deref())
                    .map(|path| format!("已找到 MPV：{}", path_to_string(path)))
                    .unwrap_or_else(|| "未找到 MPV，请选择 mpv.exe 或安装到 PATH。".to_string()),
            },
            external: PlayerProbe {
                ok: external_exists && external_template_has_url && template_error.is_none(),
                label: "外部播放器".to_string(),
                configured_path: external_path.clone(),
                resolved_path: external_path.filter(|path| Path::new(path).exists()),
                message: template_error.unwrap_or_else(|| {
                    if external_exists {
                        if external_template_has_url {
                            format!(
                                "已找到外部播放器：{}",
                                settings.player.external_player_path.unwrap_or_default()
                            )
                        } else {
                            "外部播放器参数需要包含 {url}。".to_string()
                        }
                    } else {
                        "未配置外部播放器路径。".to_string()
                    }
                }),
            },
            external_args_preview,
            external_template_has_url,
        }
    }

    pub fn test_mpv(&self, settings_store: &SettingsStore) -> PlayerProbe {
        let settings = settings_store.get();
        let Some(mpv_path) = self.resolve_mpv_path(settings.player.mpv_path.as_deref()) else {
            return PlayerProbe {
                ok: false,
                label: "MPV".to_string(),
                configured_path: settings.player.mpv_path,
                resolved_path: None,
                message: "未找到 MPV，请选择 mpv.exe 或安装到 PATH。".to_string(),
            };
        };

        match Command::new(&mpv_path)
            .arg("--version")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .creation_flags_windows()
            .output()
        {
            Ok(output) => PlayerProbe {
                ok: output.status.success(),
                label: "MPV".to_string(),
                configured_path: settings.player.mpv_path,
                resolved_path: Some(path_to_string(&mpv_path)),
                message: if output.status.success() {
                    "MPV 可启动。".to_string()
                } else {
                    format!("MPV 返回退出码 {}。", output.status.code().unwrap_or(-1))
                },
            },
            Err(err) => PlayerProbe {
                ok: false,
                label: "MPV".to_string(),
                configured_path: settings.player.mpv_path,
                resolved_path: Some(path_to_string(&mpv_path)),
                message: format!("MPV 启动失败：{}。", err),
            },
        }
    }

    pub async fn play(
        &self,
        iwara_client: &IwaraClient,
        settings_store: &SettingsStore,
        request: PlayRequest,
    ) -> AppResult<PlayResult> {
        let mut video = iwara_client.get_video(&request.video_id).await?;
        let mut settings = settings_store.add_media_hosts(
            video
                .formats
                .iter()
                .filter_map(|format| media_url_host(&format.url))
                .collect(),
        )?;
        if settings.media_speed.auto_test && settings.media_speed.ranked_hosts.is_empty() {
            let report = iwara_client
                .speed_test_video(&video.summary.id, &settings.media_speed)
                .await?;
            settings =
                settings_store.update_media_host_ranking(&report.results, &report.tested_at)?;
        }
        if settings.media_speed.replace_links {
            video = iwara_client.route_video_formats(video, &settings.media_speed);
            settings_store.add_media_hosts(
                video
                    .formats
                    .iter()
                    .filter_map(|format| media_url_host(&format.url))
                    .collect(),
            )?;
        }
        let format = choose_video_format(
            &video.formats,
            request
                .quality
                .as_deref()
                .or(settings.player.preferred_quality.as_deref()),
        )
        .ok_or_else(|| message("没有找到可播放的清晰度。"))?;
        let mode = request.mode.unwrap_or(settings.player.preferred_mode);
        let player_path = match mode {
            PlayerMode::External => {
                self.require_external_player_path(settings.player.external_player_path.as_deref())?
            }
            PlayerMode::Mpv => self.require_mpv_path(settings.player.mpv_path.as_deref())?,
        };
        if mode == PlayerMode::External
            && !template_includes_url(&settings.player.external_player_args)?
        {
            return Err(message(
                "外部播放器参数需要包含 {url}，否则播放器收不到视频地址。",
            ));
        }
        let args = match mode {
            PlayerMode::External => build_external_player_args(
                &settings.player.external_player_args,
                &PlayerTemplateValues {
                    url: &format.url,
                    title: &video.summary.title,
                    headers: HTTP_HEADERS_TEMPLATE,
                },
            )?,
            PlayerMode::Mpv => vec![
                "--force-window=yes".to_string(),
                format!("--title={}", video.summary.title),
                "--referrer=https://www.iwara.tv/".to_string(),
                format.url.clone(),
            ],
        };
        launch_player(&player_path, &args).await?;
        settings_store.add_history(crate::models::PlaybackHistoryItem {
            video: to_summary(&video),
            format_id: format.id.clone(),
            mode,
            played_at: now_iso_string(),
        })?;

        Ok(PlayResult {
            ok: true,
            mode,
            player_path: path_to_string(&player_path),
            format: format.clone(),
            video,
            fallback_from: request.quality.filter(|quality| quality != &format.id),
        })
    }

    fn require_external_player_path(&self, player_path: Option<&str>) -> AppResult<PathBuf> {
        let Some(player_path) = player_path else {
            return Err(message("外部播放器路径不存在，请先在设置中配置。"));
        };
        let path = PathBuf::from(player_path);
        if path.exists() {
            Ok(path)
        } else {
            Err(message("外部播放器路径不存在，请先在设置中配置。"))
        }
    }

    fn require_mpv_path(&self, configured_path: Option<&str>) -> AppResult<PathBuf> {
        self.resolve_mpv_path(configured_path).ok_or_else(|| {
            message("未找到 MPV。请放置 vendor/mpv/mpv.exe，安装到 PATH，或在设置中指定 mpv.exe。")
        })
    }

    fn resolve_mpv_path(&self, configured_path: Option<&str>) -> Option<PathBuf> {
        let mut candidates = Vec::new();
        if let Some(configured_path) = configured_path {
            candidates.push(PathBuf::from(configured_path));
        }
        candidates.push(PathBuf::from("vendor").join("mpv").join("mpv.exe"));
        if let Ok(resource) = self.app.path().resource_dir() {
            candidates.push(resource.join("mpv").join("mpv.exe"));
        }
        if let Some(path) = find_on_path("mpv.exe") {
            candidates.push(path);
        }
        if let Some(path) = find_on_path("mpv") {
            candidates.push(path);
        }

        candidates.into_iter().find(|path| path.exists())
    }
}

async fn launch_player(player_path: &Path, args: &[String]) -> AppResult<()> {
    let mut child = Command::new(player_path)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags_windows()
        .spawn()?;
    sleep(Duration::from_millis(750)).await;
    let _ = child.try_wait();
    Ok(())
}

fn find_on_path(command: &str) -> Option<PathBuf> {
    let lookup = if cfg!(windows) { "where.exe" } else { "which" };
    let output = Command::new(lookup).arg(command).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find(|line| !line.trim().is_empty())
        .map(|line| PathBuf::from(line.trim()))
}

fn path_to_string(path: impl AsRef<Path>) -> String {
    path.as_ref().to_string_lossy().to_string()
}

fn now_iso_string() -> String {
    crate::iwara_client::now_iso_string()
}

trait CommandExtWindows {
    fn creation_flags_windows(&mut self) -> &mut Self;
}

impl CommandExtWindows for Command {
    fn creation_flags_windows(&mut self) -> &mut Self {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            self.creation_flags(0x08000000);
        }
        self
    }
}
