use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::error::AppResult;
use crate::iwara_utils::DEFAULT_X_VERSION_SALT;
use crate::media_speed::normalize_media_host_list;
use crate::models::{
    AppSettings, DownloadSettings, IwaraRuntimeSettings, MediaSpeedCandidateResult,
    MediaSpeedSettings, PartialAppSettings, PlaybackHistoryItem, PlayerMode, PlayerSettings,
    TagPreferences, VideoSummary,
};

pub struct SettingsStore {
    file_path: PathBuf,
    settings: Mutex<AppSettings>,
}

impl SettingsStore {
    pub fn new(user_data_path: PathBuf) -> Self {
        let file_path = user_data_path.join("settings.json");
        let settings = if let Some(settings) = load_settings(&file_path) {
            settings
        } else if let Some(settings) = migrate_legacy_settings(&file_path) {
            let _ = persist_settings(&file_path, &settings);
            settings
        } else {
            default_settings()
        };
        Self {
            file_path,
            settings: Mutex::new(settings),
        }
    }

    pub fn get(&self) -> AppSettings {
        self.settings
            .lock()
            .expect("settings mutex poisoned")
            .clone()
    }

    pub fn update(&self, partial: PartialAppSettings) -> AppResult<AppSettings> {
        let next = {
            let mut settings = self.settings.lock().expect("settings mutex poisoned");
            apply_partial(&mut settings, partial);
            normalize_settings(&mut settings);
            settings.clone()
        };
        self.save(&next)?;
        Ok(next)
    }

    pub fn add_history(&self, item: PlaybackHistoryItem) -> AppResult<AppSettings> {
        let next = {
            let mut settings = self.settings.lock().expect("settings mutex poisoned");
            settings
                .history
                .retain(|entry| entry.video.id != item.video.id);
            settings.history.insert(0, item);
            settings.history.truncate(100);
            settings.clone()
        };
        self.save(&next)?;
        Ok(next)
    }

    pub fn add_media_hosts(&self, hosts: Vec<String>) -> AppResult<AppSettings> {
        let next = {
            let mut settings = self.settings.lock().expect("settings mutex poisoned");
            let mut merged = settings.media_speed.candidate_hosts.clone();
            merged.extend(hosts);
            let normalized = normalize_media_host_list(&merged);
            if normalized == settings.media_speed.candidate_hosts {
                return Ok(settings.clone());
            }
            settings.media_speed.candidate_hosts = normalized;
            settings.clone()
        };
        self.save(&next)?;
        Ok(next)
    }

    pub fn update_media_host_ranking(
        &self,
        results: &[MediaSpeedCandidateResult],
        tested_at: &str,
    ) -> AppResult<AppSettings> {
        let next = {
            let mut settings = self.settings.lock().expect("settings mutex poisoned");
            let mut ranked = results
                .iter()
                .filter(|result| result.ok)
                .collect::<Vec<_>>();
            ranked.sort_by_key(|result| std::cmp::Reverse(result.bytes_per_second.unwrap_or(0)));
            let ranked_hosts = normalize_media_host_list(
                &ranked
                    .into_iter()
                    .map(|result| result.host.clone())
                    .collect::<Vec<_>>(),
            );
            let observed = normalize_media_host_list(
                &results
                    .iter()
                    .map(|result| result.host.clone())
                    .collect::<Vec<_>>(),
            );
            let mut candidates = settings.media_speed.candidate_hosts.clone();
            candidates.extend(observed);
            settings.media_speed.candidate_hosts = normalize_media_host_list(&candidates);
            settings.media_speed.ranked_hosts = ranked_hosts;
            settings.media_speed.last_tested_at = Some(tested_at.to_string());
            settings.clone()
        };
        self.save(&next)?;
        Ok(next)
    }

    fn save(&self, settings: &AppSettings) -> AppResult<()> {
        persist_settings(&self.file_path, settings)
    }
}

pub fn to_summary(video: &crate::models::VideoDetail) -> VideoSummary {
    video.summary.clone()
}

pub fn default_settings() -> AppSettings {
    AppSettings {
        player: PlayerSettings {
            preferred_mode: PlayerMode::Mpv,
            mpv_path: None,
            external_player_path: None,
            external_player_args: "{url}".to_string(),
            preferred_quality: Some("Source".to_string()),
        },
        iwara: IwaraRuntimeSettings {
            x_version_salt: DEFAULT_X_VERSION_SALT.to_string(),
            auto_sniff_x_version_salt: true,
            last_salt_sniff_at: None,
            last_salt_source: None,
        },
        media_speed: MediaSpeedSettings {
            auto_test: false,
            replace_links: false,
            candidate_hosts: vec![
                "jade.iwara.tv".to_string(),
                "kafka.iwara.tv".to_string(),
                "bronya.iwara.tv".to_string(),
                "camellya.iwara.tv".to_string(),
            ],
            ranked_hosts: Vec::new(),
            last_tested_at: None,
            test_bytes: 524_288,
            timeout_ms: 4_500,
        },
        download: DownloadSettings {
            directory: default_download_directory(),
            default_quality: Some("Source".to_string()),
            max_connections: 4,
            min_split_bytes: 16 * 1024 * 1024,
        },
        tag_preferences: TagPreferences {
            followed_tags: Vec::new(),
            blocked_tags: Vec::new(),
            max_scan_pages: 5,
            request_delay_ms: 250,
        },
        history: Vec::new(),
    }
}

fn load_settings(path: &Path) -> Option<AppSettings> {
    let raw = fs::read_to_string(path).ok()?;
    let mut settings = merge_with_defaults(serde_json::from_str::<serde_json::Value>(&raw).ok()?);
    normalize_settings(&mut settings);
    Some(settings)
}

fn migrate_legacy_settings(new_path: &Path) -> Option<AppSettings> {
    if new_path.exists() {
        return None;
    }
    let old_path = dirs::config_dir()?.join("IwaraTV").join("settings.json");
    if old_path == new_path {
        return None;
    }
    load_settings(&old_path)
}

fn persist_settings(path: &Path, settings: &AppSettings) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(settings)?),
    )?;
    Ok(())
}

fn merge_with_defaults(raw: serde_json::Value) -> AppSettings {
    let mut defaults =
        serde_json::to_value(default_settings()).expect("default settings serializable");
    merge_json(&mut defaults, raw);
    serde_json::from_value(defaults).unwrap_or_else(|_| default_settings())
}

fn merge_json(base: &mut serde_json::Value, patch: serde_json::Value) {
    match (base, patch) {
        (serde_json::Value::Object(base), serde_json::Value::Object(patch)) => {
            for (key, value) in patch {
                merge_json(base.entry(key).or_insert(serde_json::Value::Null), value);
            }
        }
        (base, patch) => *base = patch,
    }
}

fn apply_partial(settings: &mut AppSettings, partial: PartialAppSettings) {
    if let Some(player) = partial.player {
        if let Some(value) = player.preferred_mode {
            settings.player.preferred_mode = value;
        }
        if let Some(value) = player.mpv_path {
            settings.player.mpv_path = value;
        }
        if let Some(value) = player.external_player_path {
            settings.player.external_player_path = value;
        }
        if let Some(value) = player.external_player_args {
            settings.player.external_player_args = value;
        }
        if let Some(value) = player.preferred_quality {
            settings.player.preferred_quality = value;
        }
    }

    if let Some(iwara) = partial.iwara {
        if let Some(value) = iwara.x_version_salt {
            settings.iwara.x_version_salt = value;
        }
        if let Some(value) = iwara.auto_sniff_x_version_salt {
            settings.iwara.auto_sniff_x_version_salt = value;
        }
        if let Some(value) = iwara.last_salt_sniff_at {
            settings.iwara.last_salt_sniff_at = value;
        }
        if let Some(value) = iwara.last_salt_source {
            settings.iwara.last_salt_source = value;
        }
    }

    if let Some(media_speed) = partial.media_speed {
        if let Some(value) = media_speed.auto_test {
            settings.media_speed.auto_test = value;
        }
        if let Some(value) = media_speed.replace_links {
            settings.media_speed.replace_links = value;
        }
        if let Some(value) = media_speed.candidate_hosts {
            settings.media_speed.candidate_hosts = value;
        }
        if let Some(value) = media_speed.ranked_hosts {
            settings.media_speed.ranked_hosts = value;
        }
        if let Some(value) = media_speed.last_tested_at {
            settings.media_speed.last_tested_at = value;
        }
        if let Some(value) = media_speed.test_bytes {
            settings.media_speed.test_bytes = value;
        }
        if let Some(value) = media_speed.timeout_ms {
            settings.media_speed.timeout_ms = value;
        }
    }

    if let Some(download) = partial.download {
        if let Some(value) = download.directory {
            settings.download.directory = value;
        }
        if let Some(value) = download.default_quality {
            settings.download.default_quality = value;
        }
        if let Some(value) = download.max_connections {
            settings.download.max_connections = value;
        }
        if let Some(value) = download.min_split_bytes {
            settings.download.min_split_bytes = value;
        }
    }

    if let Some(tag_preferences) = partial.tag_preferences {
        if let Some(value) = tag_preferences.followed_tags {
            settings.tag_preferences.followed_tags = value;
        }
        if let Some(value) = tag_preferences.blocked_tags {
            settings.tag_preferences.blocked_tags = value;
        }
        if let Some(value) = tag_preferences.max_scan_pages {
            settings.tag_preferences.max_scan_pages = value;
        }
        if let Some(value) = tag_preferences.request_delay_ms {
            settings.tag_preferences.request_delay_ms = value;
        }
    }

    if let Some(history) = partial.history {
        settings.history = history;
    }
}

fn normalize_settings(settings: &mut AppSettings) {
    settings.media_speed.candidate_hosts =
        normalize_media_host_list(&settings.media_speed.candidate_hosts);
    settings.media_speed.ranked_hosts =
        normalize_media_host_list(&settings.media_speed.ranked_hosts);
    settings.download = normalize_download_settings(settings.download.clone());
    settings.tag_preferences = normalize_tag_preferences(settings.tag_preferences.clone());
}

fn normalize_download_settings(settings: DownloadSettings) -> DownloadSettings {
    DownloadSettings {
        directory: settings
            .directory
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        default_quality: settings
            .default_quality
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty()),
        max_connections: clamp_integer(settings.max_connections, 1, 8, 4),
        min_split_bytes: clamp_integer(
            settings.min_split_bytes,
            1024 * 1024,
            256 * 1024 * 1024,
            16 * 1024 * 1024,
        ),
    }
}

fn default_download_directory() -> Option<String> {
    dirs::download_dir().map(|path| path.join("IwaraTV").to_string_lossy().to_string())
}

fn normalize_tag_preferences(preferences: TagPreferences) -> TagPreferences {
    let blocked_tags = normalize_tag_list(&preferences.blocked_tags);
    let blocked = blocked_tags.iter().cloned().collect::<HashSet<_>>();
    TagPreferences {
        followed_tags: normalize_tag_list(&preferences.followed_tags)
            .into_iter()
            .filter(|tag| !blocked.contains(tag))
            .collect(),
        blocked_tags,
        max_scan_pages: clamp_integer(preferences.max_scan_pages, 1, 10, 5),
        request_delay_ms: clamp_integer(preferences.request_delay_ms, 0, 1500, 250),
    }
}

fn normalize_tag_list(tags: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for tag in tags {
        let value = tag.trim().to_lowercase();
        if !value.is_empty() && seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    normalized
}

fn clamp_integer(value: u64, min: u64, max: u64, _fallback: u64) -> u64 {
    value.clamp(min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_tag_preferences() {
        let normalized = normalize_tag_preferences(TagPreferences {
            followed_tags: vec!["Koikatsu".to_string(), "muted".to_string()],
            blocked_tags: vec![" muted ".to_string()],
            max_scan_pages: 99,
            request_delay_ms: 2000,
        });
        assert_eq!(normalized.followed_tags, vec!["koikatsu"]);
        assert_eq!(normalized.blocked_tags, vec!["muted"]);
        assert_eq!(normalized.max_scan_pages, 10);
        assert_eq!(normalized.request_delay_ms, 1500);
    }
}
