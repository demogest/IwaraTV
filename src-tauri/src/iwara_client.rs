use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::fs::OpenOptions;
use tokio::io::AsyncWriteExt;
use tokio::time::sleep;
use url::Url;

use crate::auth::{is_jwt_expired, username_from_jwt, AuthStore};
use crate::error::{message, AppResult};
use crate::iwara_utils::{
    build_x_version, choose_video_format, extract_x_version_salt_from_script, format_to_extension,
    normalize_media_url, parse_iwara_video_id, quality_rank, with_iwara_download_name,
};
use crate::media_speed::{build_media_host_candidates, media_url_host, replace_media_url_host};
use crate::models::{
    AuthState, AuthorFollowRequest, AuthorFollowResult, DownloadResult, DownloadSettings,
    DownloadVideoRequest, IwaraFileProbe, IwaraNetworkCapture, IwaraVideoDiagnostics,
    ListVideosRequest, LoginRequest, MediaSpeedCandidateResult, MediaSpeedSettings,
    MediaSpeedTestReport, SendVideoCommentRequest, TagPreferences, VideoComment,
    VideoCommentsResult, VideoDetail, VideoFormat, VideoListNetworkAttempt,
    VideoListNetworkDiagnostics, VideoListResult, VideoSort, XVersionSaltReport,
};
use crate::session::IwaraSessionService;
use crate::settings::SettingsStore;

const API_BASE: &str = "https://api.iwara.tv";
const APIQ_BASE: &str = "https://apiq.iwara.tv";
const WEB_BASE: &str = "https://www.iwara.tv";
const FILES_BASE: &str = "https://files.iwara.tv";
const AVATAR_BASE: &str = "https://i.iwara.tv/image/avatar";
const DEFAULT_LIMIT: u64 = 32;
const SUBSCRIBED_LIMIT: u64 = 24;
const COMMENT_LIMIT: u64 = 8;
const LIST_RETRY_ATTEMPTS: u64 = 3;
const LIST_RETRY_BASE_DELAY_MS: u64 = 450;
const DOWNLOAD_SEGMENT_FLOOR_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct AuthProfile {
    pub username: Option<String>,
    pub avatar_url: Option<String>,
}

struct ListPageFetch {
    total: Option<u64>,
    limit: u64,
    results: Vec<crate::models::VideoSummary>,
    attempts: Vec<VideoListNetworkAttempt>,
}

struct ListPageFetchFailure {
    message: String,
    attempts: Vec<VideoListNetworkAttempt>,
}

#[derive(Clone, Debug)]
pub struct DownloadPlan {
    pub path: PathBuf,
    pub format: VideoFormat,
    pub video: VideoDetail,
    pub fallback_from: Option<String>,
}

impl DownloadPlan {
    pub fn result(self, bytes_written: u64) -> DownloadResult {
        DownloadResult {
            ok: true,
            path: path_to_string(&self.path),
            bytes_written,
            format: self.format,
            video: self.video,
            fallback_from: self.fallback_from,
        }
    }
}

#[derive(Clone, Debug)]
struct DownloadProbe {
    total_bytes: Option<u64>,
    accepts_ranges: bool,
}

#[derive(Clone, Debug)]
struct DownloadSegment {
    index: u64,
    start: u64,
    end: u64,
}

impl From<crate::error::AppError> for ListPageFetchFailure {
    fn from(err: crate::error::AppError) -> Self {
        Self {
            message: err.to_string(),
            attempts: Vec::new(),
        }
    }
}

impl From<url::ParseError> for ListPageFetchFailure {
    fn from(err: url::ParseError) -> Self {
        Self {
            message: err.to_string(),
            attempts: Vec::new(),
        }
    }
}

pub struct IwaraClient {
    http: reqwest::Client,
    auth: Arc<AuthStore>,
    session: Arc<IwaraSessionService>,
    settings: Arc<SettingsStore>,
    list_gate: tokio::sync::Mutex<()>,
    format_cache: tokio::sync::Mutex<HashMap<String, (Vec<VideoFormat>, Instant)>>,
}

impl IwaraClient {
    pub fn new(
        auth: Arc<AuthStore>,
        session: Arc<IwaraSessionService>,
        settings: Arc<SettingsStore>,
    ) -> Self {
        Self {
            http: reqwest::Client::new(),
            auth,
            session,
            settings,
            list_gate: tokio::sync::Mutex::new(()),
            format_cache: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn auth_state(&self) -> AuthState {
        self.auth.state()
    }

    pub async fn current_user_profile(&self) -> AppResult<AuthProfile> {
        let mut tokens = Vec::new();
        if let Some(token) = self.session.token().await? {
            tokens.push(token);
        }
        if let Some(token) = self.auth.get_user_token() {
            if !tokens.iter().any(|current| current == &token) {
                tokens.push(token);
            }
        }
        if tokens.is_empty() {
            return Ok(AuthProfile::default());
        }

        let mut best_profile = AuthProfile::default();
        let mut last_error = None;
        for token in tokens {
            match self
                .request_json::<Value>(
                    &format!("{API_BASE}/user"),
                    "GET",
                    vec![
                        ("Authorization".to_string(), format!("Bearer {token}")),
                        ("Content-Type".to_string(), "application/json".to_string()),
                    ],
                    None,
                    None,
                )
                .await
            {
                Ok(response) => {
                    let profile = extract_auth_profile(&response, Some(&token));
                    if best_profile.username.is_none() {
                        best_profile.username = profile.username;
                    }
                    if best_profile.avatar_url.is_none() {
                        best_profile.avatar_url = profile.avatar_url;
                    }
                    if best_profile.avatar_url.is_some() {
                        self.auth.update_user_profile(
                            best_profile.username.clone(),
                            best_profile.avatar_url.clone(),
                        );
                        return Ok(best_profile);
                    }
                }
                Err(err) => {
                    last_error = Some(err.to_string());
                }
            }
        }

        if best_profile.username.is_some() || best_profile.avatar_url.is_some() {
            self.auth.update_user_profile(
                best_profile.username.clone(),
                best_profile.avatar_url.clone(),
            );
            return Ok(best_profile);
        }

        Err(message(format!(
            "获取当前用户资料失败：{}",
            last_error.unwrap_or_else(|| "无可用 token".to_string())
        )))
    }

    pub async fn login(&self, request: LoginRequest) -> AppResult<AuthState> {
        let response = self
            .request_json::<Value>(
                &format!("{API_BASE}/user/login"),
                "POST",
                vec![("Content-Type".to_string(), "application/json".to_string())],
                Some(
                    serde_json::json!({
                        "email": request.email,
                        "password": request.password
                    })
                    .to_string(),
                ),
                None,
            )
            .await?;
        let Some(token) = response.get("token").and_then(|value| value.as_str()) else {
            let login_message = response
                .get("message")
                .and_then(|value| value.as_str())
                .unwrap_or("未返回 token");
            return Err(message(format!("Iwara 登录失败：{login_message}")));
        };

        let profile = extract_auth_profile(&response, Some(token));
        self.auth.save_user_token(
            request.email,
            token.to_string(),
            profile.username,
            profile.avatar_url,
        );
        self.refresh_media_token(token).await?;
        Ok(self.auth.state())
    }

    pub fn logout(&self) -> AuthState {
        self.auth.clear();
        self.auth.state()
    }

    pub async fn set_author_following(
        &self,
        request: AuthorFollowRequest,
    ) -> AppResult<AuthorFollowResult> {
        let author_id = request.author_id.trim();
        if author_id.is_empty() {
            return Err(message("缺少作者 ID。"));
        }

        let mut url = Url::parse(APIQ_BASE)?;
        url.path_segments_mut()
            .map_err(|_| message("无法构造 Iwara 关注接口。"))?
            .extend(["user", author_id, "followers"]);
        self.request_json_with_status::<Value>(
            &url.to_string(),
            if request.following { "POST" } else { "DELETE" },
            self.authenticated_api_headers().await?,
            None,
            None,
        )
        .await?;

        Ok(AuthorFollowResult {
            author_id: author_id.to_string(),
            following: request.following,
        })
    }

    pub async fn list_videos(
        &self,
        request: ListVideosRequest,
        tag_preferences: TagPreferences,
    ) -> AppResult<VideoListResult> {
        let _list_guard = self.list_gate.lock().await;

        if request.search_only.unwrap_or(false) {
            return self.search_videos(request, tag_preferences).await;
        }

        if request.subscribed_only.unwrap_or(false) {
            return self.list_subscribed_videos(request, tag_preferences).await;
        }

        if request.followed_only.unwrap_or(false) {
            return self.list_followed_videos(request, tag_preferences).await;
        }

        let sort = request.sort;
        let page = request.page.unwrap_or(0);
        let rating = request.rating.unwrap_or(crate::models::RatingFilter::All);
        let query = clean_query(request.query);
        let tags = normalize_tags(&request.tags.unwrap_or_default());
        let tag_preferences = normalize_list_preferences(tag_preferences);
        let required_tags = tags.iter().cloned().collect::<HashSet<_>>();
        let blocked_tags = tag_preferences
            .blocked_tags
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let needs_client_scan = tags.len() > 1 || !blocked_tags.is_empty();
        let server_tag = tags.first().cloned();
        let pages_to_scan = if needs_client_scan {
            tag_preferences.max_scan_pages
        } else {
            1
        };
        let start_page = if needs_client_scan {
            page * pages_to_scan
        } else {
            page
        };
        let mut results = Vec::new();
        let mut total = None;
        let mut scanned_pages = 0;
        let mut blocked_count = 0;
        let mut failures = Vec::new();
        let mut network_attempts = Vec::new();

        for offset in 0..pages_to_scan {
            let current_page = start_page + offset;
            if offset > 0 {
                sleep(Duration::from_millis(tag_preferences.request_delay_ms)).await;
            }
            match self
                .fetch_video_list_page_with_retry(
                    sort,
                    current_page,
                    rating,
                    query.as_deref(),
                    server_tag.as_deref(),
                    request.user_id.as_deref(),
                    false,
                    DEFAULT_LIMIT,
                )
                .await
            {
                Ok(page_fetch) => {
                    network_attempts.extend(page_fetch.attempts);
                    total = page_fetch.total.or(total);
                    scanned_pages += 1;
                    for video in page_fetch.results {
                        if matches_any_tag(&video.tags, &blocked_tags) {
                            blocked_count += 1;
                            continue;
                        }
                        if !matches_all_tags(&video.tags, &required_tags) {
                            continue;
                        }
                        results.push(video);
                        if results.len() >= DEFAULT_LIMIT as usize {
                            break;
                        }
                    }
                }
                Err(failure) => {
                    network_attempts.extend(failure.attempts);
                    failures.push(format!("第 {} 页：{}", current_page + 1, failure.message));
                }
            }
            if !needs_client_scan || results.len() >= DEFAULT_LIMIT as usize {
                break;
            }
        }

        Ok(VideoListResult {
            sort,
            page,
            limit: DEFAULT_LIMIT,
            query,
            tags,
            scanned_pages: Some(scanned_pages),
            blocked_count: Some(blocked_count),
            partial_failures: if failures.is_empty() {
                None
            } else {
                Some(failures)
            },
            total,
            network_diagnostics: list_network_diagnostics(network_attempts),
            results: dedupe_videos(results)
                .into_iter()
                .take(DEFAULT_LIMIT as usize)
                .collect(),
        })
    }

    async fn search_videos(
        &self,
        request: ListVideosRequest,
        tag_preferences: TagPreferences,
    ) -> AppResult<VideoListResult> {
        let sort = request.sort;
        let page = request.page.unwrap_or(0);
        let query = clean_query(request.query);
        let tags = normalize_tags(&request.tags.unwrap_or_default());
        let tag_preferences = normalize_list_preferences(tag_preferences);
        let required_tags = tags.iter().cloned().collect::<HashSet<_>>();
        let blocked_tags = tag_preferences
            .blocked_tags
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let needs_client_scan = !required_tags.is_empty() || !blocked_tags.is_empty();
        let pages_to_scan = if needs_client_scan {
            tag_preferences.max_scan_pages
        } else {
            1
        };
        let start_page = if needs_client_scan {
            page * pages_to_scan
        } else {
            page
        };
        let Some(query_value) = query.as_deref() else {
            return Ok(VideoListResult {
                sort,
                page,
                limit: DEFAULT_LIMIT,
                query,
                tags,
                scanned_pages: Some(0),
                blocked_count: Some(0),
                partial_failures: None,
                total: Some(0),
                network_diagnostics: None,
                results: Vec::new(),
            });
        };
        let mut results = Vec::new();
        let mut total = None;
        let mut limit = DEFAULT_LIMIT;
        let mut scanned_pages = 0;
        let mut blocked_count = 0;
        let mut failures = Vec::new();
        let mut network_attempts = Vec::new();

        for offset in 0..pages_to_scan {
            let current_page = start_page + offset;
            if offset > 0 {
                sleep(Duration::from_millis(tag_preferences.request_delay_ms)).await;
            }
            match self
                .fetch_video_search_page_with_retry(current_page, query_value, sort)
                .await
            {
                Ok(page_fetch) => {
                    network_attempts.extend(page_fetch.attempts);
                    total = page_fetch.total.or(total);
                    limit = page_fetch.limit;
                    scanned_pages += 1;
                    for video in page_fetch.results {
                        if matches_any_tag(&video.tags, &blocked_tags) {
                            blocked_count += 1;
                            continue;
                        }
                        if !matches_all_tags(&video.tags, &required_tags) {
                            continue;
                        }
                        results.push(video);
                        if results.len() >= DEFAULT_LIMIT as usize {
                            break;
                        }
                    }
                }
                Err(failure) => {
                    network_attempts.extend(failure.attempts);
                    failures.push(format!("第 {} 页：{}", current_page + 1, failure.message));
                }
            }
            if !needs_client_scan || results.len() >= DEFAULT_LIMIT as usize {
                break;
            }
        }

        Ok(VideoListResult {
            sort,
            page,
            limit,
            query,
            tags,
            scanned_pages: Some(scanned_pages),
            blocked_count: Some(blocked_count),
            partial_failures: if failures.is_empty() {
                None
            } else {
                Some(failures)
            },
            total,
            network_diagnostics: list_network_diagnostics(network_attempts),
            results: dedupe_videos(results)
                .into_iter()
                .take(DEFAULT_LIMIT as usize)
                .collect(),
        })
    }

    async fn list_subscribed_videos(
        &self,
        request: ListVideosRequest,
        tag_preferences: TagPreferences,
    ) -> AppResult<VideoListResult> {
        let sort = request.sort;
        let page = request.page.unwrap_or(0);
        let rating = request.rating.unwrap_or(crate::models::RatingFilter::All);
        let query = clean_query(request.query);
        let tags = normalize_tags(&request.tags.unwrap_or_default());
        let tag_preferences = normalize_list_preferences(tag_preferences);
        let required_tags = tags.iter().cloned().collect::<HashSet<_>>();
        let blocked_tags = tag_preferences
            .blocked_tags
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let mut network_attempts = Vec::new();
        let page_fetch = match self
            .fetch_video_list_page_with_retry(
                sort,
                page,
                rating,
                query.as_deref(),
                tags.first().map(String::as_str),
                None,
                true,
                SUBSCRIBED_LIMIT,
            )
            .await
        {
            Ok(page_fetch) => page_fetch,
            Err(failure) => {
                network_attempts.extend(failure.attempts);
                return Ok(VideoListResult {
                    sort,
                    page,
                    limit: SUBSCRIBED_LIMIT,
                    query,
                    tags,
                    scanned_pages: Some(0),
                    blocked_count: Some(0),
                    partial_failures: Some(vec![format!(
                        "第 {} 页：{}",
                        page + 1,
                        failure.message
                    )]),
                    total: None,
                    network_diagnostics: list_network_diagnostics(network_attempts),
                    results: Vec::new(),
                });
            }
        };
        network_attempts.extend(page_fetch.attempts);
        let mut blocked_count = 0;
        let results = page_fetch
            .results
            .into_iter()
            .filter(|video| {
                if matches_any_tag(&video.tags, &blocked_tags) {
                    blocked_count += 1;
                    return false;
                }
                matches_all_tags(&video.tags, &required_tags)
            })
            .collect::<Vec<_>>();

        Ok(VideoListResult {
            sort,
            page,
            limit: SUBSCRIBED_LIMIT,
            query,
            tags,
            scanned_pages: Some(1),
            blocked_count: Some(blocked_count),
            partial_failures: None,
            total: page_fetch.total,
            network_diagnostics: list_network_diagnostics(network_attempts),
            results,
        })
    }

    async fn list_followed_videos(
        &self,
        request: ListVideosRequest,
        tag_preferences: TagPreferences,
    ) -> AppResult<VideoListResult> {
        let sort = request.sort;
        let page = request.page.unwrap_or(0);
        let rating = request.rating.unwrap_or(crate::models::RatingFilter::All);
        let query = clean_query(request.query);
        let tag_preferences = normalize_list_preferences(tag_preferences);
        let followed_tags = tag_preferences
            .followed_tags
            .iter()
            .take(8)
            .cloned()
            .collect::<Vec<_>>();
        let required_tags = normalize_tags(&request.tags.unwrap_or_default())
            .into_iter()
            .collect::<HashSet<_>>();
        let blocked_tags = tag_preferences
            .blocked_tags
            .iter()
            .cloned()
            .collect::<HashSet<_>>();
        let pages_to_scan = tag_preferences.max_scan_pages;
        let start_page = page * pages_to_scan;
        let mut results = Vec::new();
        let mut blocked_count = 0;
        let mut scanned_pages = 0;
        let mut failures = Vec::new();

        if followed_tags.is_empty() {
            return Ok(VideoListResult {
                sort,
                page,
                limit: DEFAULT_LIMIT,
                query,
                tags: Vec::new(),
                scanned_pages: Some(0),
                blocked_count: Some(0),
                partial_failures: None,
                total: None,
                network_diagnostics: None,
                results: Vec::new(),
            });
        }

        let mut network_attempts = Vec::new();
        for tag in &followed_tags {
            for offset in 0..pages_to_scan {
                if scanned_pages > 0 {
                    sleep(Duration::from_millis(tag_preferences.request_delay_ms)).await;
                }
                match self
                    .fetch_video_list_page_with_retry(
                        sort,
                        start_page + offset,
                        rating,
                        query.as_deref(),
                        Some(tag),
                        request.user_id.as_deref(),
                        false,
                        DEFAULT_LIMIT,
                    )
                    .await
                {
                    Ok(page_fetch) => {
                        network_attempts.extend(page_fetch.attempts);
                        scanned_pages += 1;
                        for video in page_fetch.results {
                            if matches_any_tag(&video.tags, &blocked_tags) {
                                blocked_count += 1;
                                continue;
                            }
                            if !matches_all_tags(&video.tags, &required_tags) {
                                continue;
                            }
                            results.push(video);
                        }
                    }
                    Err(err) => {
                        network_attempts.extend(err.attempts);
                        failures.push(format!(
                            "{tag} 第 {} 页：{}",
                            start_page + offset + 1,
                            err.message
                        ))
                    }
                }
            }
        }
        let mut results = dedupe_videos(results);
        results.sort_by_key(|video| std::cmp::Reverse(date_score(video.created_at.as_deref())));

        Ok(VideoListResult {
            sort,
            page,
            limit: DEFAULT_LIMIT,
            query,
            tags: followed_tags,
            scanned_pages: Some(scanned_pages),
            blocked_count: Some(blocked_count),
            partial_failures: if failures.is_empty() {
                None
            } else {
                Some(failures)
            },
            total: None,
            network_diagnostics: list_network_diagnostics(network_attempts),
            results: results.into_iter().take(DEFAULT_LIMIT as usize).collect(),
        })
    }

    async fn fetch_video_list_page_with_retry(
        &self,
        sort: VideoSort,
        page: u64,
        rating: crate::models::RatingFilter,
        query: Option<&str>,
        tag: Option<&str>,
        user_id: Option<&str>,
        subscribed: bool,
        limit: u64,
    ) -> Result<ListPageFetch, ListPageFetchFailure> {
        let mut url = Url::parse(&format!("{API_BASE}/videos"))?;
        {
            let mut params = url.query_pairs_mut();
            if !subscribed {
                params.append_pair("sort", sort.as_api_value());
            }
            params.append_pair("rating", rating.as_api_value());
            params.append_pair("page", &page.to_string());
            params.append_pair("limit", &limit.to_string());
            params.append_pair("subscribed", if subscribed { "true" } else { "false" });
            if let Some(query) = query {
                params.append_pair("query", query);
            }
            if let Some(tag) = tag {
                params.append_pair("tags", tag);
            }
            if let Some(user_id) = user_id {
                params.append_pair("user", user_id);
            }
        }

        let headers = if subscribed {
            self.user_headers().await?
        } else {
            self.media_headers().await?
        };

        let mut attempts = Vec::new();
        let mut last_message = "列表请求失败".to_string();
        for attempt in 1..=LIST_RETRY_ATTEMPTS {
            let started = Instant::now();
            match self
                .request_json_with_status::<Value>(
                    &url.to_string(),
                    "GET",
                    headers.clone(),
                    None,
                    None,
                )
                .await
            {
                Ok((status, data)) => {
                    let total = data
                        .get("total")
                        .or_else(|| data.get("count"))
                        .and_then(Value::as_u64);
                    let results = data
                        .get("results")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .map(map_video_summary)
                        .collect::<Vec<_>>();
                    let should_retry = should_retry_empty_video_page(
                        total,
                        results.len(),
                        page,
                        sort,
                        query,
                        tag,
                        user_id,
                        subscribed,
                    );
                    attempts.push(VideoListNetworkAttempt {
                        endpoint: if subscribed {
                            "subscriptions".to_string()
                        } else {
                            "videos".to_string()
                        },
                        page,
                        attempt,
                        ok: true,
                        status: Some(status),
                        elapsed_ms: elapsed_millis(started),
                        result_count: Some(results.len()),
                        error: if should_retry {
                            Some("返回空列表，自动重试".to_string())
                        } else {
                            None
                        },
                    });
                    if should_retry && attempt < LIST_RETRY_ATTEMPTS {
                        sleep_before_list_retry(attempt).await;
                        continue;
                    }
                    return Ok(ListPageFetch {
                        total,
                        limit,
                        results,
                        attempts,
                    });
                }
                Err(err) => {
                    let message = err.to_string();
                    last_message = message.clone();
                    attempts.push(VideoListNetworkAttempt {
                        endpoint: if subscribed {
                            "subscriptions".to_string()
                        } else {
                            "videos".to_string()
                        },
                        page,
                        attempt,
                        ok: false,
                        status: http_status_from_message(&message),
                        elapsed_ms: elapsed_millis(started),
                        result_count: None,
                        error: Some(message),
                    });
                    if attempt < LIST_RETRY_ATTEMPTS && is_retryable_list_error(&last_message) {
                        sleep_before_list_retry(attempt).await;
                        continue;
                    }
                    break;
                }
            }
        }

        Err(ListPageFetchFailure {
            message: last_message,
            attempts,
        })
    }

    async fn fetch_video_search_page_with_retry(
        &self,
        page: u64,
        query: &str,
        sort: VideoSort,
    ) -> Result<ListPageFetch, ListPageFetchFailure> {
        let mut url = Url::parse(&format!("{API_BASE}/search"))?;
        {
            let mut params = url.query_pairs_mut();
            params.append_pair("type", "videos");
            params.append_pair("page", &page.to_string());
            params.append_pair("query", query);
            params.append_pair("sort", sort.as_api_value());
        }

        let headers = self.optional_user_headers().await?;
        let mut attempts = Vec::new();
        let mut last_message = "搜索请求失败".to_string();
        for attempt in 1..=LIST_RETRY_ATTEMPTS {
            let started = Instant::now();
            match self
                .request_json_with_status::<Value>(
                    &url.to_string(),
                    "GET",
                    headers.clone(),
                    None,
                    None,
                )
                .await
            {
                Ok((status, data)) => {
                    let total = data
                        .get("total")
                        .or_else(|| data.get("count"))
                        .and_then(Value::as_u64);
                    let limit = data
                        .get("limit")
                        .and_then(Value::as_u64)
                        .unwrap_or(DEFAULT_LIMIT);
                    let results = data
                        .get("results")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                        .iter()
                        .map(map_video_summary)
                        .collect::<Vec<_>>();
                    let should_retry = total.is_some_and(|total| total > 0) && results.is_empty();
                    attempts.push(VideoListNetworkAttempt {
                        endpoint: "search".to_string(),
                        page,
                        attempt,
                        ok: true,
                        status: Some(status),
                        elapsed_ms: elapsed_millis(started),
                        result_count: Some(results.len()),
                        error: if should_retry {
                            Some("返回空搜索页，自动重试".to_string())
                        } else {
                            None
                        },
                    });
                    if should_retry && attempt < LIST_RETRY_ATTEMPTS {
                        sleep_before_list_retry(attempt).await;
                        continue;
                    }
                    return Ok(ListPageFetch {
                        total,
                        limit,
                        results,
                        attempts,
                    });
                }
                Err(err) => {
                    let message = err.to_string();
                    last_message = message.clone();
                    attempts.push(VideoListNetworkAttempt {
                        endpoint: "search".to_string(),
                        page,
                        attempt,
                        ok: false,
                        status: http_status_from_message(&message),
                        elapsed_ms: elapsed_millis(started),
                        result_count: None,
                        error: Some(message),
                    });
                    if attempt < LIST_RETRY_ATTEMPTS && is_retryable_list_error(&last_message) {
                        sleep_before_list_retry(attempt).await;
                        continue;
                    }
                    break;
                }
            }
        }

        Err(ListPageFetchFailure {
            message: last_message,
            attempts,
        })
    }

    pub async fn get_video(&self, id_or_url: &str) -> AppResult<VideoDetail> {
        let id = parse_iwara_video_id(id_or_url)?;
        let data = self
            .request_json::<Value>(
                &format!("{API_BASE}/video/{id}"),
                "GET",
                self.media_headers().await?,
                None,
                None,
            )
            .await?;
        if let Some(message_value) = data.get("message").and_then(Value::as_str) {
            return match message_value {
                "errors.privateVideo" => Err(message("这是私有视频，需要登录且账号有访问权限。")),
                "errors.notFound" => Err(message("视频不存在，或需要登录后才能访问。")),
                other => Err(message(format!("Iwara API 返回错误：{other}"))),
            };
        }

        let summary = map_video_summary(&data);
        let file_url = data.get("fileUrl").and_then(Value::as_str);
        let embed_url = data
            .get("embedUrl")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let Some(file_url) = file_url else {
            if embed_url.is_some() {
                return Ok(VideoDetail {
                    summary,
                    formats: Vec::new(),
                    embed_url,
                });
            }
            return Err(message("这个视频当前没有可播放的文件。"));
        };

        let formats = self.extract_formats(&id, file_url, &summary.title).await?;
        Ok(VideoDetail {
            summary,
            formats: self.prefer_cached_formats(&id, formats).await,
            embed_url,
        })
    }

    pub async fn diagnose_video(
        &self,
        id_or_url: &str,
        capture_network: Option<IwaraNetworkCapture>,
    ) -> AppResult<IwaraVideoDiagnostics> {
        let id = parse_iwara_video_id(id_or_url)?;
        let video_headers = self.media_headers().await?;
        let data = self
            .request_json::<Value>(
                &format!("{API_BASE}/video/{id}"),
                "GET",
                video_headers.clone(),
                None,
                None,
            )
            .await?;
        let file_url = data.get("fileUrl").and_then(Value::as_str);
        let title = data
            .get("title")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        let mut probes = Vec::new();
        let mut app_format_labels = Vec::new();

        if let Some(file_url) = file_url {
            let x_version = self.build_current_x_version(file_url)?;
            let session_probe = self
                .probe_file_list(
                    "网页会话 headers",
                    file_url,
                    vec![
                        ("X-Version".to_string(), x_version.clone()),
                        ("Accept".to_string(), "application/json".to_string()),
                    ],
                )
                .await;
            probes.push(session_probe);

            let mut media_probe_headers = video_headers;
            media_probe_headers.push(("X-Version".to_string(), x_version));
            media_probe_headers.push(("Accept".to_string(), "application/json".to_string()));
            let media_probe = self
                .probe_file_list("media token headers", file_url, media_probe_headers)
                .await;
            probes.push(media_probe);
            app_format_labels = probes
                .last()
                .filter(|probe| probe.ok && !probe.format_labels.is_empty())
                .map(|probe| probe.format_labels.clone())
                .unwrap_or_else(|| {
                    probes
                        .first()
                        .map(|probe| probe.format_labels.clone())
                        .unwrap_or_default()
                });
        }

        if let Some(network) = &capture_network {
            let network_formats = best_network_formats(Some(network));
            if !network_formats.is_empty() {
                self.format_cache
                    .lock()
                    .await
                    .insert(id.clone(), (network_formats.clone(), Instant::now()));
                app_format_labels = labels_for(&network_formats);
            }
        }

        Ok(IwaraVideoDiagnostics {
            video_id: id,
            title,
            file_url: file_url.map(safe_url),
            app_format_labels,
            probes,
            network: capture_network,
        })
    }

    pub async fn speed_test_video(
        &self,
        id_or_url: &str,
        speed_settings: &MediaSpeedSettings,
    ) -> AppResult<MediaSpeedTestReport> {
        let video = self.get_video(id_or_url).await?;
        self.speed_test_hosts(&video, speed_settings).await
    }

    pub async fn download_video(
        &self,
        request: DownloadVideoRequest,
        download_settings: &DownloadSettings,
        speed_settings: &MediaSpeedSettings,
    ) -> AppResult<DownloadResult> {
        let plan = self
            .prepare_download(request, download_settings, speed_settings)
            .await?;
        let bytes_written = self
            .download_plan_to_file(&plan, download_settings, |_, _| {})
            .await?;
        Ok(plan.result(bytes_written))
    }

    pub async fn prepare_download(
        &self,
        request: DownloadVideoRequest,
        download_settings: &DownloadSettings,
        speed_settings: &MediaSpeedSettings,
    ) -> AppResult<DownloadPlan> {
        let mut video = self.get_video(&request.video_id).await?;
        if speed_settings.replace_links {
            video = self.route_video_formats(video, speed_settings);
        }

        let requested_quality = request
            .quality
            .or_else(|| download_settings.default_quality.clone());
        let format = choose_video_format(&video.formats, requested_quality.as_deref())
            .ok_or_else(|| message("没有找到可下载的清晰度。"))?;
        let directory = download_settings
            .directory
            .as_deref()
            .ok_or_else(|| message("请先在设置中选择下载保存路径。"))?;
        let directory = Path::new(directory);
        tokio::fs::create_dir_all(directory).await?;
        let path =
            unique_download_path(directory, &video.summary.title, &video.summary.id, &format)
                .await?;

        Ok(DownloadPlan {
            path,
            format: format.clone(),
            video,
            fallback_from: requested_quality.filter(|quality| quality != &format.id),
        })
    }

    pub async fn download_plan_to_file<F>(
        &self,
        plan: &DownloadPlan,
        download_settings: &DownloadSettings,
        progress: F,
    ) -> AppResult<u64>
    where
        F: Fn(u64, Option<u64>) + Send + Sync,
    {
        self.download_media_to_file(
            &plan.format.url,
            &plan.path,
            download_settings.max_connections,
            download_settings.min_split_bytes,
            progress,
        )
        .await
    }

    pub fn route_video_formats(
        &self,
        mut video: VideoDetail,
        speed_settings: &MediaSpeedSettings,
    ) -> VideoDetail {
        if !speed_settings.replace_links || speed_settings.ranked_hosts.is_empty() {
            return video;
        }
        video.formats = video
            .formats
            .into_iter()
            .map(|format| {
                let current_host = media_url_host(&format.url);
                if let Some(target_host) = speed_settings.ranked_hosts.first() {
                    if current_host.as_deref() != Some(target_host.as_str()) {
                        if let Some(url) = replace_media_url_host(&format.url, target_host) {
                            return VideoFormat { url, ..format };
                        }
                    }
                }
                format
            })
            .collect();
        video
    }

    pub async fn sniff_x_version_salt(&self) -> AppResult<XVersionSaltReport> {
        let checked_at = now_iso_string();
        let home = self
            .fetch_text(
                &format!("{WEB_BASE}/"),
                vec![("Accept".to_string(), "text/html".to_string())],
            )
            .await?;
        let mut script_urls = script_src_pattern()
            .captures_iter(&home)
            .filter_map(|captures| {
                captures
                    .get(1)
                    .and_then(|value| absolute_web_url(value.as_str()))
            })
            .collect::<Vec<_>>();
        script_urls.sort_by_key(|url| std::cmp::Reverse(score_script_url(url)));

        for source_url in script_urls {
            let script = self
                .fetch_text(
                    &source_url,
                    vec![(
                        "Accept".to_string(),
                        "application/javascript,text/javascript,*/*".to_string(),
                    )],
                )
                .await?;
            if let Some(salt) = extract_x_version_salt_from_script(&script) {
                return Ok(XVersionSaltReport {
                    salt,
                    source_url,
                    checked_at,
                });
            }
        }

        Err(message("没有在 Iwara 前端脚本里找到 X-Version 盐值。"))
    }

    pub async fn list_video_comments(&self, id_or_url: &str) -> AppResult<VideoCommentsResult> {
        let video_id = parse_iwara_video_id(id_or_url)?;
        let (comments, total) = self.fetch_video_comments(&video_id, None).await?;
        Ok(VideoCommentsResult {
            video_id,
            comments,
            total,
            fetched_at: now_iso_string(),
        })
    }

    pub async fn send_video_comment(
        &self,
        request: SendVideoCommentRequest,
    ) -> AppResult<VideoComment> {
        let video_id = parse_iwara_video_id(&request.video_id)?;
        let body = request.body.trim();
        if body.is_empty() {
            return Err(message("评论内容不能为空。"));
        }
        let mut payload = serde_json::json!({ "body": body });
        if let Some(parent_id) = request.parent_id {
            payload["parent"] = Value::String(parent_id);
        }
        let mut headers = self.media_headers().await?;
        headers.push(("Content-Type".to_string(), "application/json".to_string()));
        let response = self
            .request_json::<Value>(
                &format!("{API_BASE}/video/{video_id}/comments"),
                "POST",
                headers,
                Some(payload.to_string()),
                None,
            )
            .await?;
        map_video_comment(&response)
            .ok_or_else(|| message("评论已提交，但 Iwara 没有返回可显示的评论内容。"))
    }

    async fn fetch_video_comments(
        &self,
        video_id: &str,
        parent_id: Option<&str>,
    ) -> AppResult<(Vec<VideoComment>, u64)> {
        let mut url = Url::parse(&format!("{API_BASE}/video/{video_id}/comments"))?;
        url.query_pairs_mut()
            .append_pair("page", "0")
            .append_pair("limit", &COMMENT_LIMIT.to_string());
        if let Some(parent_id) = parent_id {
            url.query_pairs_mut().append_pair("parent", parent_id);
        }

        let first = self.fetch_comments_page(&url).await?;
        let limit = first.2.max(COMMENT_LIMIT);
        let total = first.1;
        let pages = ((total as f64) / (limit as f64)).ceil().max(1.0) as u64;
        let mut all = first.0;
        for page in 1..pages {
            url.query_pairs_mut()
                .clear()
                .append_pair("page", &page.to_string())
                .append_pair("limit", &COMMENT_LIMIT.to_string());
            if let Some(parent_id) = parent_id {
                url.query_pairs_mut().append_pair("parent", parent_id);
            }
            all.extend(self.fetch_comments_page(&url).await?.0);
        }
        let mut comments = all.iter().filter_map(map_video_comment).collect::<Vec<_>>();
        for comment in &mut comments {
            if comment.num_replies > 0 {
                let replies = Box::pin(self.fetch_video_comments(video_id, Some(&comment.id)))
                    .await
                    .unwrap_or_else(|_| (Vec::new(), 0));
                comment.replies = replies.0;
            }
        }
        Ok((comments, total))
    }

    async fn fetch_comments_page(&self, url: &Url) -> AppResult<(Vec<Value>, u64, u64)> {
        let data = self
            .request_json::<Value>(
                &url.to_string(),
                "GET",
                self.media_headers().await?,
                None,
                None,
            )
            .await?;
        Ok((
            data.get("results")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default(),
            data.get("total")
                .or_else(|| data.get("count"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            data.get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(COMMENT_LIMIT),
        ))
    }

    async fn extract_formats(
        &self,
        video_id: &str,
        file_url: &str,
        title: &str,
    ) -> AppResult<Vec<VideoFormat>> {
        let x_version = self.build_current_x_version(file_url)?;
        let mut headers = self.media_headers().await?;
        headers.push(("X-Version".to_string(), x_version));
        headers.push(("Accept".to_string(), "application/json".to_string()));
        let files = self
            .request_json::<Value>(
                &with_iwara_download_name(file_url, title, video_id)?,
                "GET",
                headers,
                None,
                Some(video_id.to_string()),
            )
            .await?;
        let mut formats = normalize_file_list(&files)
            .iter()
            .filter_map(map_video_format)
            .collect::<Vec<_>>();
        formats.sort_by_key(|format| format.quality_rank);
        Ok(formats)
    }

    async fn speed_test_hosts(
        &self,
        video: &VideoDetail,
        speed_settings: &MediaSpeedSettings,
    ) -> AppResult<MediaSpeedTestReport> {
        let sample = video
            .formats
            .iter()
            .max_by_key(|format| format.quality_rank)
            .cloned();
        let sample_host = sample
            .as_ref()
            .and_then(|format| media_url_host(&format.url));
        let mut discovered_hosts = video
            .formats
            .iter()
            .filter_map(|format| media_url_host(&format.url))
            .collect::<Vec<_>>();
        discovered_hosts.extend(speed_settings.candidate_hosts.clone());
        let candidates = sample
            .as_ref()
            .map(|format| build_media_host_candidates(&format.url, &discovered_hosts))
            .unwrap_or_default();
        let mut results = Vec::new();
        for (host, url) in candidates {
            results.push(self.test_media_url(host, url, speed_settings).await);
        }
        let fastest = results
            .iter()
            .filter(|result| result.ok && result.bytes_per_second.is_some())
            .max_by_key(|result| result.bytes_per_second.unwrap_or(0));
        Ok(MediaSpeedTestReport {
            video_id: video.summary.id.clone(),
            title: Some(video.summary.title.clone()),
            sample_format_id: sample.as_ref().map(|format| format.id.clone()),
            sample_format_label: sample.as_ref().map(|format| format.label.clone()),
            sample_host,
            tested_at: now_iso_string(),
            replace_links: speed_settings.replace_links,
            fastest_host: fastest.map(|result| result.host.clone()),
            results,
        })
    }

    async fn test_media_url(
        &self,
        host: String,
        url: String,
        speed_settings: &MediaSpeedSettings,
    ) -> MediaSpeedCandidateResult {
        let started = Instant::now();
        let headers = self
            .session
            .headers_for(&url)
            .await
            .unwrap_or_default()
            .into_iter()
            .chain([
                ("Referer".to_string(), "https://www.iwara.tv/".to_string()),
                (
                    "Range".to_string(),
                    format!("bytes=0-{}", speed_settings.test_bytes.saturating_sub(1)),
                ),
            ])
            .collect::<Vec<_>>();
        let result = tokio::time::timeout(
            Duration::from_millis(speed_settings.timeout_ms),
            self.http.get(&url).headers(to_header_map(headers)).send(),
        )
        .await;
        match result {
            Ok(Ok(response)) => {
                if !response.status().is_success() && response.status().as_u16() != 206 {
                    return failed_media_result(
                        host,
                        url,
                        format!("HTTP {}", response.status().as_u16()),
                    );
                }
                match response.bytes().await {
                    Ok(bytes) if !bytes.is_empty() => {
                        let bytes_read = bytes.len().min(speed_settings.test_bytes as usize) as u64;
                        let elapsed_ms = started.elapsed().as_millis().max(1) as u64;
                        MediaSpeedCandidateResult {
                            host,
                            url,
                            ok: true,
                            elapsed_ms: Some(elapsed_ms),
                            bytes_read: Some(bytes_read),
                            bytes_per_second: Some((bytes_read * 1000) / elapsed_ms),
                            error: None,
                        }
                    }
                    Ok(_) => failed_media_result(host, url, "没有读取到数据".to_string()),
                    Err(err) => failed_media_result(host, url, err.to_string()),
                }
            }
            Ok(Err(err)) => failed_media_result(host, url, err.to_string()),
            Err(_) => failed_media_result(host, url, "operation timed out".to_string()),
        }
    }

    async fn download_media_to_file<F>(
        &self,
        url: &str,
        path: &Path,
        max_connections: u64,
        min_split_bytes: u64,
        progress: F,
    ) -> AppResult<u64>
    where
        F: Fn(u64, Option<u64>) + Send + Sync,
    {
        let mut headers = self.session.headers_for(url).await.unwrap_or_default();
        headers.extend([
            ("Accept".to_string(), "*/*".to_string()),
            ("Referer".to_string(), "https://www.iwara.tv/".to_string()),
            ("Origin".to_string(), "https://www.iwara.tv".to_string()),
        ]);

        let probe = self.probe_download(url, &headers).await;
        if let Ok(probe) = &probe {
            if let Some(total_bytes) = probe.total_bytes {
                let connections = max_connections.clamp(1, 8);
                if probe.accepts_ranges
                    && connections > 1
                    && total_bytes >= min_split_bytes.max(DOWNLOAD_SEGMENT_FLOOR_BYTES)
                {
                    return self
                        .download_media_segments(
                            url,
                            path,
                            &headers,
                            total_bytes,
                            connections,
                            progress,
                        )
                        .await;
                }
            }
        }

        self.download_media_single(
            url,
            path,
            &headers,
            probe.ok().and_then(|probe| probe.total_bytes),
            progress,
        )
        .await
    }

    async fn probe_download(
        &self,
        url: &str,
        headers: &[(String, String)],
    ) -> AppResult<DownloadProbe> {
        let response = self
            .http
            .get(url)
            .headers(to_header_map(
                headers
                    .iter()
                    .cloned()
                    .chain([("Range".to_string(), "bytes=0-0".to_string())])
                    .collect(),
            ))
            .send()
            .await?;
        if response.status().as_u16() == 206 {
            let headers = response.headers();
            return Ok(DownloadProbe {
                total_bytes: headers
                    .get("content-range")
                    .and_then(|value| value.to_str().ok())
                    .and_then(total_bytes_from_content_range)
                    .or_else(|| headers.get("content-length").and_then(header_u64)),
                accepts_ranges: true,
            });
        }

        if !response.status().is_success() {
            return Err(message(format!(
                "下载请求失败：HTTP {}",
                response.status().as_u16()
            )));
        }

        let headers = response.headers();
        Ok(DownloadProbe {
            total_bytes: headers.get("content-length").and_then(header_u64),
            accepts_ranges: headers
                .get("accept-ranges")
                .and_then(|value| value.to_str().ok())
                .is_some_and(|value| value.eq_ignore_ascii_case("bytes")),
        })
    }

    async fn download_media_single<F>(
        &self,
        url: &str,
        path: &Path,
        headers: &[(String, String)],
        total_bytes: Option<u64>,
        progress: F,
    ) -> AppResult<u64>
    where
        F: Fn(u64, Option<u64>) + Send + Sync,
    {
        let part_path = partial_download_path(path);
        let existing_bytes = tokio::fs::metadata(&part_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if existing_bytes > 0 && total_bytes.is_some_and(|total| existing_bytes >= total) {
            tokio::fs::rename(&part_path, path).await?;
            progress(existing_bytes, total_bytes);
            return Ok(existing_bytes);
        }
        let mut request_headers = headers.to_vec();
        if existing_bytes > 0 {
            request_headers.push(("Range".to_string(), format!("bytes={existing_bytes}-")));
        }
        let response = self
            .http
            .get(url)
            .headers(to_header_map(request_headers))
            .send()
            .await?;
        if existing_bytes > 0 && response.status().as_u16() != 206 {
            let _ = tokio::fs::remove_file(&part_path).await;
        }
        if !response.status().is_success() {
            return Err(message(format!(
                "下载请求失败：HTTP {}",
                response.status().as_u16()
            )));
        }
        let appending = existing_bytes > 0 && response.status().as_u16() == 206;
        let mut file = OpenOptions::new()
            .create(true)
            .append(appending)
            .write(true)
            .truncate(!appending)
            .open(&part_path)
            .await?;
        let mut bytes_written = if appending { existing_bytes } else { 0 };
        progress(bytes_written, total_bytes);
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            bytes_written += chunk.len() as u64;
            progress(bytes_written, total_bytes);
        }
        file.flush().await?;
        drop(file);

        if bytes_written == 0 {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(message("下载完成但没有写入任何数据。"));
        }

        tokio::fs::rename(&part_path, path).await?;
        Ok(bytes_written)
    }

    async fn download_media_segments<F>(
        &self,
        url: &str,
        path: &Path,
        headers: &[(String, String)],
        total_bytes: u64,
        max_connections: u64,
        progress: F,
    ) -> AppResult<u64>
    where
        F: Fn(u64, Option<u64>) + Send + Sync,
    {
        let segments = download_segments(total_bytes, max_connections);
        let initial_bytes = initial_segment_bytes(path, &segments).await;
        let progress_bytes = Arc::new(AtomicU64::new(initial_bytes));
        progress(initial_bytes, Some(total_bytes));
        let progress = Arc::new(progress);
        let results = futures_util::stream::iter(segments.clone())
            .map(|segment| {
                let headers = headers.to_vec();
                let progress_bytes = Arc::clone(&progress_bytes);
                let progress = Arc::clone(&progress);
                async move {
                    self.download_segment(
                        url,
                        path,
                        &headers,
                        total_bytes,
                        segment,
                        progress_bytes,
                        progress,
                    )
                    .await
                }
            })
            .buffer_unordered(max_connections as usize)
            .collect::<Vec<_>>()
            .await;

        for result in results {
            result?;
        }

        merge_segments(path, &segments).await?;
        progress(total_bytes, Some(total_bytes));
        Ok(total_bytes)
    }

    async fn download_segment<F>(
        &self,
        url: &str,
        path: &Path,
        headers: &[(String, String)],
        total_bytes: u64,
        segment: DownloadSegment,
        progress_bytes: Arc<AtomicU64>,
        progress: Arc<F>,
    ) -> AppResult<()>
    where
        F: Fn(u64, Option<u64>) + Send + Sync,
    {
        let part_path = segment_part_path(path, segment.index);
        let expected_len = segment.end - segment.start + 1;
        let actual_len = tokio::fs::metadata(&part_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        if actual_len > expected_len {
            let file = OpenOptions::new().write(true).open(&part_path).await?;
            file.set_len(expected_len).await?;
        }
        let mut existing_len = actual_len.min(expected_len);
        if existing_len == expected_len {
            return Ok(());
        }
        if existing_len > 0 {
            let file = OpenOptions::new().write(true).open(&part_path).await?;
            file.set_len(existing_len).await?;
        }

        let range_start = segment.start + existing_len;
        let mut request_headers = headers.to_vec();
        request_headers.push((
            "Range".to_string(),
            format!("bytes={range_start}-{}", segment.end),
        ));
        let response = self
            .http
            .get(url)
            .headers(to_header_map(request_headers))
            .send()
            .await?;
        if response.status().as_u16() != 206 {
            return Err(message(format!(
                "分片下载请求失败：HTTP {}",
                response.status().as_u16()
            )));
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(existing_len > 0)
            .write(true)
            .truncate(existing_len == 0)
            .open(&part_path)
            .await?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            file.write_all(&chunk).await?;
            existing_len += chunk.len() as u64;
            let current = progress_bytes.fetch_add(chunk.len() as u64, Ordering::Relaxed)
                + chunk.len() as u64;
            progress(current.min(total_bytes), Some(total_bytes));
        }
        file.flush().await?;

        if existing_len != expected_len {
            return Err(message(format!(
                "分片 {} 下载不完整：{} / {}",
                segment.index + 1,
                existing_len,
                expected_len
            )));
        }

        Ok(())
    }

    async fn prefer_cached_formats(
        &self,
        video_id: &str,
        direct_formats: Vec<VideoFormat>,
    ) -> Vec<VideoFormat> {
        let mut cache = self.format_cache.lock().await;
        let Some((formats, captured_at)) = cache.get(video_id).cloned() else {
            return direct_formats;
        };
        if captured_at.elapsed() > Duration::from_secs(15 * 60) {
            cache.remove(video_id);
            return direct_formats;
        }
        let direct_best = best_quality_rank(&direct_formats);
        let cached_best = best_quality_rank(&formats);
        if cached_best > direct_best || formats.len() > direct_formats.len() {
            formats
        } else {
            direct_formats
        }
    }

    async fn probe_file_list(
        &self,
        label: &str,
        file_url: &str,
        headers: Vec<(String, String)>,
    ) -> IwaraFileProbe {
        match self
            .request_json_with_status::<Value>(file_url, "GET", headers, None, None)
            .await
        {
            Ok((status, json)) => IwaraFileProbe {
                label: label.to_string(),
                url: safe_url(file_url),
                ok: true,
                status: Some(status),
                format_labels: normalize_file_list(&json)
                    .iter()
                    .filter_map(map_video_format)
                    .map(|format| format.label)
                    .collect(),
                error: None,
            },
            Err(err) => IwaraFileProbe {
                label: label.to_string(),
                url: safe_url(file_url),
                ok: false,
                status: None,
                format_labels: Vec::new(),
                error: Some(err.to_string()),
            },
        }
    }

    async fn media_headers(&self) -> AppResult<Vec<(String, String)>> {
        let session_token = self.session.token().await?;
        let user_token = self.auth.get_user_token().or(session_token.clone());
        let Some(user_token) = user_token else {
            return Ok(Vec::new());
        };
        if let Some(media_token) = self.auth.get_media_token() {
            if !is_jwt_expired(&media_token, 120) {
                return Ok(vec![(
                    "Authorization".to_string(),
                    format!("Bearer {media_token}"),
                )]);
            }
        }
        match self.refresh_media_token(&user_token).await {
            Ok(refreshed) => Ok(vec![(
                "Authorization".to_string(),
                format!("Bearer {refreshed}"),
            )]),
            Err(err) => {
                if let Some(session_token) = session_token {
                    Ok(vec![(
                        "Authorization".to_string(),
                        format!("Bearer {session_token}"),
                    )])
                } else {
                    Err(err)
                }
            }
        }
    }

    async fn user_headers(&self) -> AppResult<Vec<(String, String)>> {
        if let Some(token) = self.session.token().await? {
            if !is_jwt_expired(&token, 120) {
                return Ok(vec![
                    ("Authorization".to_string(), format!("Bearer {token}")),
                    ("Content-Type".to_string(), "application/json".to_string()),
                ]);
            }
        }

        if let Some(token) = self.auth.get_user_token() {
            if is_jwt_expired(&token, 120) {
                self.auth.clear();
                return Err(message("登录已过期，请重新登录。"));
            }

            return Ok(vec![
                ("Authorization".to_string(), format!("Bearer {token}")),
                ("Content-Type".to_string(), "application/json".to_string()),
            ]);
        }

        Err(message("查看订阅视频需要先登录 Iwara。"))
    }

    async fn authenticated_api_headers(&self) -> AppResult<Vec<(String, String)>> {
        if let Some(token) = self.auth.get_media_token() {
            if !is_jwt_expired(&token, 120) {
                return Ok(vec![(
                    "Authorization".to_string(),
                    format!("Bearer {token}"),
                )]);
            }
        }

        if let Some(token) = self.session.token().await? {
            if !is_jwt_expired(&token, 120) {
                return Ok(vec![(
                    "Authorization".to_string(),
                    format!("Bearer {token}"),
                )]);
            }
        }

        if let Some(token) = self.auth.get_user_token() {
            let refreshed = self.refresh_media_token(&token).await?;
            return Ok(vec![(
                "Authorization".to_string(),
                format!("Bearer {refreshed}"),
            )]);
        }

        Err(message("关注作者需要先登录 Iwara。"))
    }

    async fn optional_user_headers(&self) -> AppResult<Vec<(String, String)>> {
        let content_type = ("Content-Type".to_string(), "application/json".to_string());
        if let Some(token) = self.session.token().await? {
            if !is_jwt_expired(&token, 120) {
                return Ok(vec![
                    ("Authorization".to_string(), format!("Bearer {token}")),
                    content_type,
                ]);
            }
        }

        if let Some(token) = self.auth.get_user_token() {
            if !is_jwt_expired(&token, 120) {
                return Ok(vec![
                    ("Authorization".to_string(), format!("Bearer {token}")),
                    content_type,
                ]);
            }
        }

        Ok(vec![content_type])
    }

    async fn refresh_media_token(&self, user_token: &str) -> AppResult<String> {
        if is_jwt_expired(user_token, 120) {
            self.auth.clear();
            return Err(message("登录已过期，请重新登录。"));
        }
        let response = self
            .request_json::<Value>(
                &format!("{API_BASE}/user/token"),
                "POST",
                vec![
                    ("Authorization".to_string(), format!("Bearer {user_token}")),
                    ("Content-Type".to_string(), "application/json".to_string()),
                ],
                Some(String::new()),
                None,
            )
            .await?;
        let Some(token) = response.get("accessToken").and_then(Value::as_str) else {
            return Err(message("无法获取 Iwara 媒体访问 token。"));
        };
        self.auth.set_media_token(token.to_string());
        Ok(token.to_string())
    }

    async fn request_json<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        method: &str,
        headers: Vec<(String, String)>,
        body: Option<String>,
        context_id: Option<String>,
    ) -> AppResult<T> {
        Ok(self
            .request_json_with_status(url, method, headers, body, context_id)
            .await?
            .1)
    }

    async fn request_json_with_status<T: serde::de::DeserializeOwned>(
        &self,
        url: &str,
        method: &str,
        headers: Vec<(String, String)>,
        body: Option<String>,
        _context_id: Option<String>,
    ) -> AppResult<(u16, T)> {
        let mut merged_headers = vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("X-Site".to_string(), "www.iwara.tv".to_string()),
            ("Referer".to_string(), "https://www.iwara.tv/".to_string()),
            ("Origin".to_string(), "https://www.iwara.tv".to_string()),
        ];
        merged_headers.extend(self.session.headers_for(url).await.unwrap_or_default());
        merged_headers.extend(headers);
        let response = self
            .send_request(url, method, &merged_headers, body.clone())
            .await?;
        let content_type = response
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.as_str())
            .unwrap_or("");
        let mut text = response.text;
        if text.trim().is_empty() {
            if !(200..300).contains(&response.status) {
                return Err(message(format!(
                    "Iwara API 请求失败：HTTP {}",
                    response.status
                )));
            }
            return Ok((response.status, serde_json::from_str("{}")?));
        }
        if (!content_type.contains("application/json") || looks_like_cloudflare(&text))
            && self.session.can_use_iwara_page_fetch(url, &merged_headers)
        {
            if let Ok(fallback) = self
                .session
                .fetch_inside_iwara_page(url, method, &merged_headers, body.clone())
                .await
            {
                text = fallback.text;
            }
        }
        if !content_type.contains("application/json")
            && !text.trim_start().starts_with('{')
            && !text.trim_start().starts_with('[')
        {
            if looks_like_cloudflare(&text) {
                return Err(message(
                    "Iwara 返回了浏览器验证页面，请先在站点完成验证或稍后重试。",
                ));
            }
            return Err(message(format!(
                "Iwara 返回了非 JSON 内容：HTTP {}",
                response.status
            )));
        }
        let json = if text.trim().is_empty() {
            serde_json::from_str("{}")?
        } else {
            serde_json::from_str(&text)?
        };
        if !(200..300).contains(&response.status) {
            return Err(message(format!(
                "Iwara API 请求失败：HTTP {}",
                response.status
            )));
        }
        Ok((response.status, json))
    }

    async fn send_request(
        &self,
        url: &str,
        method: &str,
        headers: &[(String, String)],
        body: Option<String>,
    ) -> AppResult<SimpleResponse> {
        let builder = match method {
            "POST" => self.http.post(url),
            "PUT" => self.http.put(url),
            "DELETE" => self.http.delete(url),
            _ => self.http.get(url),
        }
        .headers(to_header_map(headers.to_vec()));
        let builder = if let Some(body) = body {
            builder.body(body)
        } else {
            builder
        };
        let response = builder.send().await?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_string(),
                    value.to_str().unwrap_or("").to_string(),
                )
            })
            .collect();
        let text = response.text().await?;
        Ok(SimpleResponse {
            status,
            headers,
            text,
        })
    }

    async fn fetch_text(&self, url: &str, headers: Vec<(String, String)>) -> AppResult<String> {
        let mut merged_headers = vec![("Referer".to_string(), "https://www.iwara.tv/".to_string())];
        merged_headers.extend(self.session.headers_for(url).await.unwrap_or_default());
        merged_headers.extend(headers);
        let response = self.send_request(url, "GET", &merged_headers, None).await?;
        if !(200..300).contains(&response.status) {
            return Err(message(format!(
                "Iwara 前端脚本请求失败：HTTP {}",
                response.status
            )));
        }
        if looks_like_cloudflare(&response.text) {
            return Err(message("Iwara 前端脚本请求返回了浏览器验证页面。"));
        }
        Ok(response.text)
    }

    fn build_current_x_version(&self, file_url: &str) -> AppResult<String> {
        build_x_version(file_url, Some(&self.settings.get().iwara.x_version_salt))
    }
}

async fn unique_download_path(
    directory: &Path,
    title: &str,
    video_id: &str,
    format: &VideoFormat,
) -> AppResult<PathBuf> {
    let extension = download_extension(format);
    let stem = sanitize_file_stem(&format!("{title} [{video_id}] - {}", format.label));
    for index in 0..1000 {
        let file_name = if index == 0 {
            format!("{stem}.{extension}")
        } else {
            format!("{stem} ({index}).{extension}")
        };
        let candidate = directory.join(file_name);
        if tokio::fs::metadata(&candidate).await.is_err() {
            return Ok(candidate);
        }
    }
    Err(message("无法生成不重复的下载文件名。"))
}

fn download_extension(format: &VideoFormat) -> String {
    format
        .ext
        .as_deref()
        .filter(|value| is_safe_extension(value))
        .map(ToString::to_string)
        .or_else(|| extension_from_url(&format.url))
        .unwrap_or_else(|| "mp4".to_string())
}

fn extension_from_url(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let name = parsed.path_segments()?.next_back()?;
    let extension = Path::new(name).extension()?.to_str()?.to_lowercase();
    is_safe_extension(&extension).then_some(extension)
}

fn is_safe_extension(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 8
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric())
}

fn sanitize_file_stem(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| match character {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            character if character.is_control() => '_',
            character => character,
        })
        .collect::<String>();
    let trimmed = sanitized.trim().trim_matches('.').to_string();
    let fallback = if trimmed.is_empty() {
        "Iwara Video".to_string()
    } else {
        trimmed
    };
    fallback.chars().take(150).collect()
}

fn partial_download_path(path: &Path) -> PathBuf {
    let part_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| format!("{name}.part"))
        .unwrap_or_else(|| "download.part".to_string());
    path.with_file_name(part_name)
}

fn segment_part_path(path: &Path, index: u64) -> PathBuf {
    let part_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| format!("{name}.part{index}"))
        .unwrap_or_else(|| format!("download.part{index}"));
    path.with_file_name(part_name)
}

fn download_segments(total_bytes: u64, max_connections: u64) -> Vec<DownloadSegment> {
    let count = max_connections
        .max(1)
        .min(8)
        .min((total_bytes / DOWNLOAD_SEGMENT_FLOOR_BYTES).max(1));
    let segment_size = total_bytes.div_ceil(count);
    (0..count)
        .filter_map(|index| {
            let start = index * segment_size;
            if start >= total_bytes {
                return None;
            }
            Some(DownloadSegment {
                index,
                start,
                end: ((index + 1) * segment_size)
                    .saturating_sub(1)
                    .min(total_bytes - 1),
            })
        })
        .collect()
}

async fn initial_segment_bytes(path: &Path, segments: &[DownloadSegment]) -> u64 {
    let mut total = 0;
    for segment in segments {
        let expected = segment.end - segment.start + 1;
        total += tokio::fs::metadata(segment_part_path(path, segment.index))
            .await
            .map(|metadata| metadata.len().min(expected))
            .unwrap_or(0);
    }
    total
}

async fn merge_segments(path: &Path, segments: &[DownloadSegment]) -> AppResult<()> {
    let mut output = tokio::fs::File::create(path).await?;
    for segment in segments {
        let part_path = segment_part_path(path, segment.index);
        let mut input = tokio::fs::File::open(&part_path).await?;
        tokio::io::copy(&mut input, &mut output).await?;
        tokio::fs::remove_file(part_path).await?;
    }
    output.flush().await?;
    Ok(())
}

fn header_u64(value: &HeaderValue) -> Option<u64> {
    value.to_str().ok()?.parse().ok()
}

fn total_bytes_from_content_range(value: &str) -> Option<u64> {
    value
        .rsplit_once('/')
        .and_then(|(_, total)| total.parse::<u64>().ok())
}

fn path_to_string(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

#[derive(Clone)]
pub struct SimpleResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub text: String,
}

pub fn summarize_json_response(body: &str) -> (Vec<String>, Option<Vec<VideoFormat>>, String) {
    match serde_json::from_str::<Value>(body) {
        Ok(json) => {
            let formats = normalize_file_list(&json)
                .iter()
                .filter_map(map_video_format)
                .collect::<Vec<_>>();
            let labels = formats
                .iter()
                .map(|format| format.label.clone())
                .collect::<Vec<_>>();
            (labels, Some(formats), response_shape(&json))
        }
        Err(_) => (Vec::new(), None, "non-json".to_string()),
    }
}

fn to_header_map(headers: Vec<(String, String)>) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (key, value) in headers {
        if let (Ok(name), Ok(value)) = (
            HeaderName::from_bytes(key.as_bytes()),
            HeaderValue::from_str(&value),
        ) {
            map.insert(name, value);
        }
    }
    map
}

fn clean_query(query: Option<String>) -> Option<String> {
    query
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_tags(tags: &[String]) -> Vec<String> {
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

fn normalize_list_preferences(preferences: TagPreferences) -> TagPreferences {
    TagPreferences {
        followed_tags: normalize_tags(&preferences.followed_tags),
        blocked_tags: normalize_tags(&preferences.blocked_tags),
        max_scan_pages: preferences.max_scan_pages.clamp(1, 10),
        request_delay_ms: preferences.request_delay_ms.clamp(0, 1500),
    }
}

fn list_network_diagnostics(
    attempts: Vec<VideoListNetworkAttempt>,
) -> Option<VideoListNetworkDiagnostics> {
    if attempts.is_empty() {
        None
    } else {
        Some(VideoListNetworkDiagnostics { attempts })
    }
}

fn should_retry_empty_video_page(
    total: Option<u64>,
    result_count: usize,
    page: u64,
    sort: VideoSort,
    query: Option<&str>,
    tag: Option<&str>,
    user_id: Option<&str>,
    subscribed: bool,
) -> bool {
    if result_count > 0 {
        return false;
    }
    if total.is_some_and(|total| total > 0) {
        return true;
    }

    !subscribed
        && page == 0
        && sort == VideoSort::Date
        && query.is_none()
        && tag.is_none()
        && user_id.is_none()
}

fn is_retryable_list_error(message: &str) -> bool {
    let normalized = message.to_lowercase();
    if message.contains("登录")
        || message.contains("权限")
        || message.contains("浏览器验证")
        || normalized.contains("cloudflare")
    {
        return false;
    }

    match http_status_from_message(message) {
        Some(401 | 403 | 404) => false,
        Some(408 | 409 | 425 | 429) => true,
        Some(status) => status >= 500,
        None => true,
    }
}

fn http_status_from_message(message: &str) -> Option<u16> {
    let uppercase = message.to_uppercase();
    let (_, tail) = uppercase.split_once("HTTP ")?;
    let code = tail
        .chars()
        .take_while(|ch| ch.is_ascii_digit())
        .collect::<String>();
    code.parse().ok()
}

fn elapsed_millis(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

async fn sleep_before_list_retry(attempt: u64) {
    sleep(Duration::from_millis(LIST_RETRY_BASE_DELAY_MS * attempt)).await;
}

fn matches_any_tag(video_tags: &[String], tags: &HashSet<String>) -> bool {
    if tags.is_empty() {
        return false;
    }
    let video_tags = video_tags
        .iter()
        .map(|tag| tag.trim().to_lowercase())
        .collect::<HashSet<_>>();
    tags.iter().any(|tag| video_tags.contains(tag))
}

fn matches_all_tags(video_tags: &[String], tags: &HashSet<String>) -> bool {
    if tags.is_empty() {
        return true;
    }
    let video_tags = video_tags
        .iter()
        .map(|tag| tag.trim().to_lowercase())
        .collect::<HashSet<_>>();
    tags.iter().all(|tag| video_tags.contains(tag))
}

fn dedupe_videos(videos: Vec<crate::models::VideoSummary>) -> Vec<crate::models::VideoSummary> {
    let mut seen = HashSet::new();
    videos
        .into_iter()
        .filter(|video| seen.insert(video.id.clone()))
        .collect()
}

fn date_score(value: Option<&str>) -> i64 {
    value
        .and_then(|value| OffsetDateTime::parse(value, &Rfc3339).ok())
        .map(|date| date.unix_timestamp())
        .unwrap_or(0)
}

fn map_video_summary(raw: &Value) -> crate::models::VideoSummary {
    let user = raw.get("user").unwrap_or(&Value::Null);
    let file = raw.get("file").unwrap_or(&Value::Null);
    crate::models::VideoSummary {
        id: value_to_string(raw.get("id")).unwrap_or_default(),
        title: value_to_string(raw.get("title")).unwrap_or_else(|| "Untitled".to_string()),
        description: plain_text(raw.get("body")),
        uploader_id: value_to_string(user.get("id")),
        uploader_name: value_to_string(user.get("name")),
        uploader_username: value_to_string(user.get("username")),
        uploader_avatar_url: image_file_url(user.get("avatar").unwrap_or(&Value::Null), "avatar"),
        uploader_following: user.get("following").and_then(Value::as_bool),
        thumbnail_url: thumbnail_url(file),
        rating: value_to_string(raw.get("rating")),
        tags: raw
            .get("tags")
            .and_then(Value::as_array)
            .map(|tags| {
                tags.iter()
                    .filter_map(|tag| {
                        tag.as_str()
                            .map(ToString::to_string)
                            .or_else(|| value_to_string(tag.get("id")))
                    })
                    .collect()
            })
            .unwrap_or_default(),
        num_views: raw.get("numViews").and_then(Value::as_u64).unwrap_or(0),
        num_likes: raw.get("numLikes").and_then(Value::as_u64).unwrap_or(0),
        num_comments: raw.get("numComments").and_then(Value::as_u64).unwrap_or(0),
        duration_seconds: first_duration_seconds([
            raw.get("duration"),
            file.get("duration"),
            raw.get("length"),
            file.get("length"),
        ]),
        created_at: value_to_string(raw.get("createdAt")),
        updated_at: value_to_string(raw.get("updatedAt")),
    }
}

fn map_video_comment(raw: &Value) -> Option<VideoComment> {
    let user = raw.get("user").unwrap_or(&Value::Null);
    let body = plain_text(
        raw.get("body")
            .or_else(|| raw.get("comment"))
            .or_else(|| raw.get("text")),
    )?;
    Some(VideoComment {
        id: value_to_string(raw.get("id")).unwrap_or_else(|| {
            format!(
                "{}-{}",
                value_to_string(user.get("username")).unwrap_or_else(|| "comment".to_string()),
                value_to_string(raw.get("createdAt")).unwrap_or_default()
            )
        }),
        body,
        author_name: value_to_string(user.get("name")),
        author_username: value_to_string(user.get("username")),
        created_at: value_to_string(raw.get("createdAt")),
        num_likes: raw.get("numLikes").and_then(Value::as_u64).unwrap_or(0),
        num_replies: raw.get("numReplies").and_then(Value::as_u64).unwrap_or(0),
        replies: Vec::new(),
    })
}

pub fn map_video_format(raw: &Value) -> Option<VideoFormat> {
    let label = value_to_string(raw.get("name"))
        .or_else(|| value_to_string(raw.get("label")))
        .or_else(|| value_to_string(raw.get("quality")))
        .or_else(|| value_to_string(raw.get("height")))
        .unwrap_or_else(|| "unknown".to_string());
    let url = format_url(raw)?;
    let mime_type = value_to_string(raw.get("type"));
    Some(VideoFormat {
        id: label.clone(),
        label: label.clone(),
        url: normalize_media_url(&url),
        mime_type: mime_type.clone(),
        ext: format_to_extension(mime_type.as_deref()),
        height: label.parse::<u64>().ok(),
        quality_rank: quality_rank(&label),
    })
}

fn format_url(value: &Value) -> Option<String> {
    if let Some(src) = value.get("src") {
        if let Some(value) = src.as_str() {
            return Some(value.to_string());
        }
        if src.is_object() {
            return value_to_string(src.get("download"))
                .or_else(|| value_to_string(src.get("view")))
                .or_else(|| value_to_string(src.get("src")))
                .or_else(|| value_to_string(src.get("url")));
        }
    }
    value_to_string(value.get("download"))
        .or_else(|| value_to_string(value.get("view")))
        .or_else(|| value_to_string(value.get("url")))
}

fn value_to_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn extract_auth_username(response: &Value) -> Option<String> {
    response
        .get("user")
        .and_then(|user| {
            value_to_string(user.get("username"))
                .or_else(|| value_to_string(user.get("name")))
                .or_else(|| value_to_string(user.get("displayName")))
                .or_else(|| value_to_string(user.get("display_name")))
        })
        .or_else(|| value_to_string(response.get("username")))
        .or_else(|| value_to_string(response.get("name")))
        .or_else(|| value_to_string(response.get("displayName")))
        .or_else(|| value_to_string(response.get("display_name")))
}

fn extract_auth_profile(response: &Value, token: Option<&str>) -> AuthProfile {
    AuthProfile {
        username: extract_auth_username(response).or_else(|| token.and_then(username_from_jwt)),
        avatar_url: extract_auth_avatar_url(response),
    }
}

fn extract_auth_avatar_url(response: &Value) -> Option<String> {
    response
        .get("user")
        .and_then(|user| auth_avatar_file_url(user.get("avatar").unwrap_or(&Value::Null)))
        .or_else(|| {
            response
                .get("data")
                .and_then(|data| data.get("user"))
                .and_then(|user| auth_avatar_file_url(user.get("avatar").unwrap_or(&Value::Null)))
        })
        .or_else(|| auth_avatar_file_url(response.get("avatar").unwrap_or(&Value::Null)))
}

fn auth_avatar_file_url(avatar: &Value) -> Option<String> {
    let avatar_id = value_to_string(avatar.get("id")).or_else(|| value_to_string(Some(avatar)))?;
    Some(format!("{AVATAR_BASE}/{avatar_id}/{avatar_id}.jpg"))
}

fn thumbnail_url(file: &Value) -> Option<String> {
    value_to_string(file.get("id"))
        .map(|file_id| format!("{FILES_BASE}/image/thumbnail/{file_id}/thumbnail-00.jpg"))
}

fn image_file_url(file: &Value, variant: &str) -> Option<String> {
    let file_id = value_to_string(file.get("id"))?;
    let file_name = value_to_string(file.get("name"))?;
    Some(format!(
        "{FILES_BASE}/image/{variant}/{file_id}/{file_name}"
    ))
}

fn plain_text(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    let mut stripped = html_break_pattern().replace_all(value, "\n").to_string();
    stripped = html_paragraph_end_pattern()
        .replace_all(&stripped, "\n")
        .to_string();
    stripped = html_tag_pattern().replace_all(&stripped, "").to_string();
    stripped = stripped
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    stripped = repeated_newline_pattern()
        .replace_all(&stripped, "\n\n")
        .trim()
        .to_string();
    if stripped.is_empty() {
        None
    } else {
        Some(stripped)
    }
}

fn first_duration_seconds(values: [Option<&Value>; 4]) -> Option<u64> {
    values.into_iter().flatten().find_map(duration_seconds)
}

fn duration_seconds(value: &Value) -> Option<u64> {
    if let Some(number) = value.as_f64() {
        if number.is_finite() && number > 0.0 {
            return Some(
                (if number > 360_000.0 {
                    number / 1000.0
                } else {
                    number
                })
                .round() as u64,
            );
        }
    }
    let trimmed = value.as_str()?.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(number) = trimmed.parse::<f64>() {
        return duration_seconds(&serde_json::json!(number));
    }
    let parts = trimmed
        .split(':')
        .filter_map(|part| part.parse::<u64>().ok())
        .collect::<Vec<_>>();
    match parts.as_slice() {
        [minutes, seconds] => Some(minutes * 60 + seconds),
        [hours, minutes, seconds] => Some(hours * 3600 + minutes * 60 + seconds),
        _ => None,
    }
}

fn normalize_file_list(value: &Value) -> Vec<Value> {
    if let Some(array) = value.as_array() {
        return array.clone();
    }
    ["files", "results", "data"]
        .iter()
        .find_map(|key| value.get(*key).and_then(Value::as_array).cloned())
        .unwrap_or_default()
}

fn best_network_formats(network: Option<&IwaraNetworkCapture>) -> Vec<VideoFormat> {
    network
        .map(|network| {
            network
                .entries
                .iter()
                .filter_map(|entry| entry.formats.clone())
                .filter(|formats| !formats.is_empty())
                .max_by_key(|formats| best_quality_rank(formats))
                .unwrap_or_default()
        })
        .unwrap_or_default()
}

fn best_quality_rank(formats: &[VideoFormat]) -> u64 {
    formats
        .iter()
        .map(|format| format.quality_rank)
        .max()
        .unwrap_or(0)
}

fn labels_for(formats: &[VideoFormat]) -> Vec<String> {
    let mut formats = formats.to_vec();
    formats.sort_by_key(|format| std::cmp::Reverse(format.quality_rank));
    formats.into_iter().map(|format| format.label).collect()
}

fn absolute_web_url(src: &str) -> Option<String> {
    Url::parse(src)
        .or_else(|_| Url::parse(WEB_BASE).and_then(|base| base.join(src)))
        .ok()
        .map(|url| url.to_string())
}

fn score_script_url(url: &str) -> u8 {
    if main_script_pattern().is_match(url) {
        2
    } else if url.ends_with(".js") {
        1
    } else {
        0
    }
}

fn safe_url(url: &str) -> String {
    Url::parse(url)
        .map(|mut parsed| {
            if parsed.query().is_some() {
                parsed.set_query(Some("..."));
            }
            parsed.to_string()
        })
        .unwrap_or_else(|_| url.to_string())
}

fn response_shape(value: &Value) -> String {
    match value {
        Value::Array(values) => format!("array({})", values.len()),
        Value::Object(map) => format!(
            "object({})",
            map.keys().cloned().collect::<Vec<_>>().join(", ")
        ),
        _ => value.to_string(),
    }
}

fn looks_like_cloudflare(text: &str) -> bool {
    let normalized = text.to_lowercase();
    normalized.contains("<html") || normalized.contains("cloudflare")
}

fn failed_media_result(host: String, url: String, error: String) -> MediaSpeedCandidateResult {
    MediaSpeedCandidateResult {
        host,
        url,
        ok: false,
        elapsed_ms: None,
        bytes_read: None,
        bytes_per_second: None,
        error: Some(error),
    }
}

pub fn now_iso_string() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn script_src_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']"#)
            .expect("valid script src regex")
    })
}

fn html_break_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)<br\s*/?>").expect("valid HTML break regex"))
}

fn html_paragraph_end_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"(?i)</p>").expect("valid HTML paragraph regex"))
}

fn html_tag_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"<[^>]+>").expect("valid HTML tag regex"))
}

fn repeated_newline_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"\n{3,}").expect("valid repeated newline regex"))
}

fn main_script_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"/main\.[\w-]+\.js").expect("valid main script regex"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_tags_with_blocked_tags() {
        let videos = vec![crate::models::VideoSummary {
            id: "ok".to_string(),
            title: "ok".to_string(),
            description: None,
            uploader_id: None,
            uploader_name: None,
            uploader_username: None,
            uploader_avatar_url: None,
            uploader_following: None,
            thumbnail_url: None,
            rating: None,
            tags: vec!["breeding".to_string(), "koikatsu".to_string()],
            num_views: 0,
            num_likes: 0,
            num_comments: 0,
            duration_seconds: None,
            created_at: None,
            updated_at: None,
        }];
        let required = ["breeding".to_string(), "koikatsu".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();
        assert!(matches_all_tags(&videos[0].tags, &required));
        assert!(!matches_any_tag(
            &videos[0].tags,
            &["muted".to_string()].into_iter().collect()
        ));
    }

    #[test]
    fn splits_download_segments_without_gaps() {
        let total = 10 * 1024 * 1024;
        let segments = download_segments(total, 4);

        assert_eq!(segments.len(), 4);
        assert_eq!(segments[0].start, 0);
        assert_eq!(segments.last().map(|segment| segment.end), Some(total - 1));
        for pair in segments.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
    }

    #[test]
    fn parses_content_range_total_size() {
        assert_eq!(
            total_bytes_from_content_range("bytes 0-0/12345"),
            Some(12_345)
        );
        assert_eq!(total_bytes_from_content_range("bytes */987"), Some(987));
    }

    #[test]
    fn extracts_username_from_current_user_response() {
        let response = serde_json::json!({
            "balance": 0,
            "user": {
                "id": "user-id",
                "name": "demo_user",
                "username": "demo_user",
                "avatar": {
                    "id": "e8532034-73e1-48d3-ad31-344ae7aa7768"
                }
            },
            "profile": {
                "user": null
            }
        });

        let profile = extract_auth_profile(&response, None);

        assert_eq!(profile.username.as_deref(), Some("demo_user"));
        assert_eq!(
            profile.avatar_url.as_deref(),
            Some("https://i.iwara.tv/image/avatar/e8532034-73e1-48d3-ad31-344ae7aa7768/e8532034-73e1-48d3-ad31-344ae7aa7768.jpg")
        );
    }
}
