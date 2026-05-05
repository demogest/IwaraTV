use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoSummary {
    pub id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader_avatar_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uploader_following: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rating: Option<String>,
    pub tags: Vec<String>,
    pub num_views: u64,
    pub num_likes: u64,
    pub num_comments: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoFormat {
    pub id: String,
    pub label: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ext: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u64>,
    pub quality_rank: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoComment {
    pub id: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub author_username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    pub num_likes: u64,
    pub num_replies: u64,
    pub replies: Vec<VideoComment>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDetail {
    #[serde(flatten)]
    pub summary: VideoSummary,
    pub formats: Vec<VideoFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub embed_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoCommentsResult {
    pub video_id: String,
    pub comments: Vec<VideoComment>,
    pub total: u64,
    pub fetched_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IwaraRuntimeSettings {
    pub x_version_salt: String,
    pub auto_sniff_x_version_salt: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_salt_sniff_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_salt_source: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeedSettings {
    pub auto_test: bool,
    pub replace_links: bool,
    pub candidate_hosts: Vec<String>,
    pub ranked_hosts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_tested_at: Option<String>,
    pub test_bytes: u64,
    pub timeout_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TagPreferences {
    pub followed_tags: Vec<String>,
    pub blocked_tags: Vec<String>,
    pub max_scan_pages: u64,
    pub request_delay_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadSettings {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_quality: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeedCandidateResult {
    pub host: String,
    pub url: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_read: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes_per_second: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSpeedTestReport {
    pub video_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_format_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_format_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_host: Option<String>,
    pub tested_at: String,
    pub replace_links: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fastest_host: Option<String>,
    pub results: Vec<MediaSpeedCandidateResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XVersionSaltReport {
    pub salt: String,
    pub source_url: String,
    pub checked_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IwaraFileProbe {
    pub label: String,
    pub url: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub format_labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IwaraNetworkEntry {
    pub url: String,
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_type: Option<String>,
    pub format_labels: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub formats: Option<Vec<VideoFormat>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub has_authorization: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_shape: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IwaraNetworkCapture {
    pub page_url: String,
    pub entries: Vec<IwaraNetworkEntry>,
    pub timed_out: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IwaraVideoDiagnostics {
    pub video_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_url: Option<String>,
    pub app_format_labels: Vec<String>,
    pub probes: Vec<IwaraFileProbe>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network: Option<IwaraNetworkCapture>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoListNetworkAttempt {
    pub endpoint: String,
    pub page: u64,
    pub attempt: u64,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoListNetworkDiagnostics {
    pub attempts: Vec<VideoListNetworkAttempt>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoListResult {
    pub sort: VideoSort,
    pub page: u64,
    pub limit: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scanned_pages: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocked_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_failures: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub network_diagnostics: Option<VideoListNetworkDiagnostics>,
    pub results: Vec<VideoSummary>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSettings {
    pub preferred_mode: PlayerMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mpv_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_player_path: Option<String>,
    pub external_player_args: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preferred_quality: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackHistoryItem {
    pub video: VideoSummary,
    pub format_id: String,
    pub played_at: String,
    pub mode: PlayerMode,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub player: PlayerSettings,
    pub iwara: IwaraRuntimeSettings,
    pub media_speed: MediaSpeedSettings,
    pub download: DownloadSettings,
    pub tag_preferences: TagPreferences,
    pub history: Vec<PlaybackHistoryItem>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialAppSettings {
    #[serde(default)]
    pub player: Option<PartialPlayerSettings>,
    #[serde(default)]
    pub iwara: Option<PartialIwaraRuntimeSettings>,
    #[serde(default)]
    pub media_speed: Option<PartialMediaSpeedSettings>,
    #[serde(default)]
    pub download: Option<PartialDownloadSettings>,
    #[serde(default)]
    pub tag_preferences: Option<PartialTagPreferences>,
    #[serde(default)]
    pub history: Option<Vec<PlaybackHistoryItem>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialPlayerSettings {
    #[serde(default)]
    pub preferred_mode: Option<PlayerMode>,
    #[serde(default)]
    pub mpv_path: Option<Option<String>>,
    #[serde(default)]
    pub external_player_path: Option<Option<String>>,
    #[serde(default)]
    pub external_player_args: Option<String>,
    #[serde(default)]
    pub preferred_quality: Option<Option<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialIwaraRuntimeSettings {
    #[serde(default)]
    pub x_version_salt: Option<String>,
    #[serde(default)]
    pub auto_sniff_x_version_salt: Option<bool>,
    #[serde(default)]
    pub last_salt_sniff_at: Option<Option<String>>,
    #[serde(default)]
    pub last_salt_source: Option<Option<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialMediaSpeedSettings {
    #[serde(default)]
    pub auto_test: Option<bool>,
    #[serde(default)]
    pub replace_links: Option<bool>,
    #[serde(default)]
    pub candidate_hosts: Option<Vec<String>>,
    #[serde(default)]
    pub ranked_hosts: Option<Vec<String>>,
    #[serde(default)]
    pub last_tested_at: Option<Option<String>>,
    #[serde(default)]
    pub test_bytes: Option<u64>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialDownloadSettings {
    #[serde(default)]
    pub directory: Option<Option<String>>,
    #[serde(default)]
    pub default_quality: Option<Option<String>>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PartialTagPreferences {
    #[serde(default)]
    pub followed_tags: Option<Vec<String>>,
    #[serde(default)]
    pub blocked_tags: Option<Vec<String>>,
    #[serde(default)]
    pub max_scan_pages: Option<u64>,
    #[serde(default)]
    pub request_delay_ms: Option<u64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthState {
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar_url: Option<String>,
    pub has_media_token: bool,
    pub encryption_available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_session_ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_cookie_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_token_ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub site_token_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub browser_user_agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum VideoSort {
    Date,
    Trending,
    Popularity,
    Relevance,
    Views,
    Likes,
}

impl VideoSort {
    pub fn as_api_value(self) -> &'static str {
        match self {
            Self::Date => "date",
            Self::Trending => "trending",
            Self::Popularity => "popularity",
            Self::Relevance => "relevance",
            Self::Views => "views",
            Self::Likes => "likes",
        }
    }
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum RatingFilter {
    All,
    General,
    Ecchi,
}

impl RatingFilter {
    pub fn as_api_value(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::General => "general",
            Self::Ecchi => "ecchi",
        }
    }
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum PlayerMode {
    Mpv,
    External,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListVideosRequest {
    pub sort: VideoSort,
    #[serde(default)]
    pub page: Option<u64>,
    #[serde(default)]
    pub rating: Option<RatingFilter>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub followed_only: Option<bool>,
    #[serde(default)]
    pub subscribed_only: Option<bool>,
    #[serde(default)]
    pub search_only: Option<bool>,
    #[serde(default)]
    pub user_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListVideoCommentsRequest {
    pub video_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendVideoCommentRequest {
    pub video_id: String,
    pub body: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorFollowRequest {
    pub author_id: String,
    pub following: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorFollowResult {
    pub author_id: String,
    pub following: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    pub video_id: String,
    #[serde(default)]
    pub quality: Option<String>,
    #[serde(default)]
    pub mode: Option<PlayerMode>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayResult {
    pub ok: bool,
    pub mode: PlayerMode,
    pub player_path: String,
    pub format: VideoFormat,
    pub video: VideoDetail,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_from: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadVideoRequest {
    pub video_id: String,
    #[serde(default)]
    pub quality: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadResult {
    pub ok: bool,
    pub path: String,
    pub bytes_written: u64,
    pub format: VideoFormat,
    pub video: VideoDetail,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_from: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerProbe {
    pub ok: bool,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub configured_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_path: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerDiagnostics {
    pub mpv: PlayerProbe,
    pub external: PlayerProbe,
    pub external_args_preview: Vec<String>,
    pub external_template_has_url: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectExecutableRequest {
    pub title: String,
    #[serde(default)]
    pub current_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectExecutableResult {
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectDirectoryRequest {
    pub title: String,
    #[serde(default)]
    pub current_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectDirectoryResult {
    pub canceled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}
