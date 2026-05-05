use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};

use regex::Regex;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
use tokio::time::sleep;
use url::Url;

use crate::auth::{is_jwt_expired, AuthStore};
use crate::error::{message, AppResult};
use crate::iwara_utils::{
    build_x_version, extract_x_version_salt_from_script, format_to_extension, normalize_media_url,
    parse_iwara_video_id, quality_rank, with_iwara_download_name,
};
use crate::media_speed::{build_media_host_candidates, media_url_host, replace_media_url_host};
use crate::models::{
    AuthState, IwaraFileProbe, IwaraNetworkCapture, IwaraVideoDiagnostics, ListVideosRequest,
    LoginRequest, MediaSpeedCandidateResult, MediaSpeedSettings, MediaSpeedTestReport, SendVideoCommentRequest,
    TagPreferences, VideoComment, VideoCommentsResult, VideoDetail, VideoFormat, VideoListResult, VideoSort,
    XVersionSaltReport,
};
use crate::session::IwaraSessionService;
use crate::settings::SettingsStore;

const API_BASE: &str = "https://api.iwara.tv";
const WEB_BASE: &str = "https://www.iwara.tv";
const FILES_BASE: &str = "https://files.iwara.tv";
const DEFAULT_LIMIT: u64 = 32;
const COMMENT_LIMIT: u64 = 8;

pub struct IwaraClient {
    http: reqwest::Client,
    auth: Arc<AuthStore>,
    session: Arc<IwaraSessionService>,
    settings: Arc<SettingsStore>,
    format_cache: tokio::sync::Mutex<HashMap<String, (Vec<VideoFormat>, Instant)>>,
}

impl IwaraClient {
    pub fn new(auth: Arc<AuthStore>, session: Arc<IwaraSessionService>, settings: Arc<SettingsStore>) -> Self {
        Self {
            http: reqwest::Client::new(),
            auth,
            session,
            settings,
            format_cache: tokio::sync::Mutex::new(HashMap::new()),
        }
    }

    pub fn auth_state(&self) -> AuthState {
        self.auth.state()
    }

    pub async fn login(&self, request: LoginRequest) -> AppResult<AuthState> {
        let response = self
            .request_json::<Value>(
                &format!("{API_BASE}/user/login"),
                "POST",
                vec![("Content-Type".to_string(), "application/json".to_string())],
                Some(serde_json::json!({
                    "email": request.email,
                    "password": request.password
                })
                .to_string()),
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

        self.auth.save_user_token(request.email, token.to_string());
        self.refresh_media_token(token).await?;
        Ok(self.auth.state())
    }

    pub fn logout(&self) -> AuthState {
        self.auth.clear();
        self.auth.state()
    }

    pub async fn list_videos(&self, request: ListVideosRequest, tag_preferences: TagPreferences) -> AppResult<VideoListResult> {
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
        let blocked_tags = tag_preferences.blocked_tags.iter().cloned().collect::<HashSet<_>>();
        let needs_client_scan = tags.len() > 1 || !blocked_tags.is_empty();
        let server_tag = tags.first().cloned();
        let pages_to_scan = if needs_client_scan { tag_preferences.max_scan_pages } else { 1 };
        let start_page = if needs_client_scan { page * pages_to_scan } else { page };
        let mut results = Vec::new();
        let mut total = None;
        let mut scanned_pages = 0;
        let mut blocked_count = 0;
        let mut failures = Vec::new();

        for offset in 0..pages_to_scan {
            let current_page = start_page + offset;
            if offset > 0 {
                sleep(Duration::from_millis(tag_preferences.request_delay_ms)).await;
            }
            match self
                .fetch_video_list_page(sort, current_page, rating, query.as_deref(), server_tag.as_deref(), request.user_id.as_deref())
                .await
            {
                Ok((page_total, page_results)) => {
                    total = page_total.or(total);
                    scanned_pages += 1;
                    for video in page_results {
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
                Err(err) => failures.push(format!("第 {} 页：{}", current_page + 1, err)),
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
            partial_failures: if failures.is_empty() { None } else { Some(failures) },
            total,
            results: dedupe_videos(results).into_iter().take(DEFAULT_LIMIT as usize).collect(),
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
        let blocked_tags = tag_preferences.blocked_tags.iter().cloned().collect::<HashSet<_>>();
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
                results: Vec::new(),
            });
        }

        for tag in &followed_tags {
            for offset in 0..pages_to_scan {
                if scanned_pages > 0 {
                    sleep(Duration::from_millis(tag_preferences.request_delay_ms)).await;
                }
                match self
                    .fetch_video_list_page(sort, start_page + offset, rating, query.as_deref(), Some(tag), request.user_id.as_deref())
                    .await
                {
                    Ok((_total, page_results)) => {
                        scanned_pages += 1;
                        for video in page_results {
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
                    Err(err) => failures.push(format!("{tag} 第 {} 页：{}", start_page + offset + 1, err)),
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
            partial_failures: if failures.is_empty() { None } else { Some(failures) },
            total: None,
            results: results.into_iter().take(DEFAULT_LIMIT as usize).collect(),
        })
    }

    async fn fetch_video_list_page(
        &self,
        sort: VideoSort,
        page: u64,
        rating: crate::models::RatingFilter,
        query: Option<&str>,
        tag: Option<&str>,
        user_id: Option<&str>,
    ) -> AppResult<(Option<u64>, Vec<crate::models::VideoSummary>)> {
        let mut url = Url::parse(&format!("{API_BASE}/videos"))?;
        {
            let mut params = url.query_pairs_mut();
            params.append_pair("sort", sort.as_api_value());
            params.append_pair("rating", rating.as_api_value());
            params.append_pair("page", &page.to_string());
            params.append_pair("limit", &DEFAULT_LIMIT.to_string());
            params.append_pair("subscribed", "false");
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

        let data = self
            .request_json::<Value>(&url.to_string(), "GET", self.media_headers().await?, None, None)
            .await?;
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
            .collect();
        Ok((total, results))
    }

    pub async fn get_video(&self, id_or_url: &str) -> AppResult<VideoDetail> {
        let id = parse_iwara_video_id(id_or_url)?;
        let data = self
            .request_json::<Value>(&format!("{API_BASE}/video/{id}"), "GET", self.media_headers().await?, None, None)
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
        let embed_url = data.get("embedUrl").and_then(Value::as_str).map(ToString::to_string);
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

    pub async fn diagnose_video(&self, id_or_url: &str, capture_network: Option<IwaraNetworkCapture>) -> AppResult<IwaraVideoDiagnostics> {
        let id = parse_iwara_video_id(id_or_url)?;
        let video_headers = self.media_headers().await?;
        let data = self
            .request_json::<Value>(&format!("{API_BASE}/video/{id}"), "GET", video_headers.clone(), None, None)
            .await?;
        let file_url = data.get("fileUrl").and_then(Value::as_str);
        let title = data.get("title").and_then(Value::as_str).map(ToString::to_string);
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
            let media_probe = self.probe_file_list("media token headers", file_url, media_probe_headers).await;
            probes.push(media_probe);
            app_format_labels = probes
                .last()
                .filter(|probe| probe.ok && !probe.format_labels.is_empty())
                .map(|probe| probe.format_labels.clone())
                .unwrap_or_else(|| probes.first().map(|probe| probe.format_labels.clone()).unwrap_or_default());
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

    pub fn route_video_formats(&self, mut video: VideoDetail, speed_settings: &MediaSpeedSettings) -> VideoDetail {
        if !speed_settings.replace_links || speed_settings.ranked_hosts.is_empty() {
            return video;
        }
        video.formats = video
            .formats
            .into_iter()
            .map(|format| {
                let current_host = media_url_host(&format.url);
                let target_host = speed_settings.ranked_hosts.first();
                let routed_url = target_host.and_then(|host| replace_media_url_host(&format.url, host));
                if routed_url.is_some() && target_host.cloned() != current_host {
                    VideoFormat {
                        url: routed_url.unwrap(),
                        ..format
                    }
                } else {
                    format
                }
            })
            .collect();
        video
    }

    pub async fn sniff_x_version_salt(&self) -> AppResult<XVersionSaltReport> {
        let checked_at = now_iso_string();
        let home = self.fetch_text(&format!("{WEB_BASE}/"), vec![("Accept".to_string(), "text/html".to_string())]).await?;
        let pattern = Regex::new(r#"<script[^>]+src=["']([^"']+\.js(?:\?[^"']*)?)["']"#).unwrap();
        let mut script_urls = pattern
            .captures_iter(&home)
            .filter_map(|captures| captures.get(1).and_then(|value| absolute_web_url(value.as_str())))
            .collect::<Vec<_>>();
        script_urls.sort_by_key(|url| std::cmp::Reverse(score_script_url(url)));

        for source_url in script_urls {
            let script = self
                .fetch_text(&source_url, vec![("Accept".to_string(), "application/javascript,text/javascript,*/*".to_string())])
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

    pub async fn send_video_comment(&self, request: SendVideoCommentRequest) -> AppResult<VideoComment> {
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
            .request_json::<Value>(&format!("{API_BASE}/video/{video_id}/comments"), "POST", headers, Some(payload.to_string()), None)
            .await?;
        map_video_comment(&response).ok_or_else(|| message("评论已提交，但 Iwara 没有返回可显示的评论内容。"))
    }

    async fn fetch_video_comments(&self, video_id: &str, parent_id: Option<&str>) -> AppResult<(Vec<VideoComment>, u64)> {
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
            url.query_pairs_mut().clear().append_pair("page", &page.to_string()).append_pair("limit", &COMMENT_LIMIT.to_string());
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
            .request_json::<Value>(&url.to_string(), "GET", self.media_headers().await?, None, None)
            .await?;
        Ok((
            data.get("results").and_then(Value::as_array).cloned().unwrap_or_default(),
            data.get("total").or_else(|| data.get("count")).and_then(Value::as_u64).unwrap_or(0),
            data.get("limit").and_then(Value::as_u64).unwrap_or(COMMENT_LIMIT),
        ))
    }

    async fn extract_formats(&self, video_id: &str, file_url: &str, title: &str) -> AppResult<Vec<VideoFormat>> {
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
        let sample_host = sample.as_ref().and_then(|format| media_url_host(&format.url));
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
                    return failed_media_result(host, url, format!("HTTP {}", response.status().as_u16()));
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

    async fn prefer_cached_formats(&self, video_id: &str, direct_formats: Vec<VideoFormat>) -> Vec<VideoFormat> {
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

    async fn probe_file_list(&self, label: &str, file_url: &str, headers: Vec<(String, String)>) -> IwaraFileProbe {
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
                return Ok(vec![("Authorization".to_string(), format!("Bearer {media_token}"))]);
            }
        }
        match self.refresh_media_token(&user_token).await {
            Ok(refreshed) => Ok(vec![("Authorization".to_string(), format!("Bearer {refreshed}"))]),
            Err(err) => {
                if let Some(session_token) = session_token {
                    Ok(vec![("Authorization".to_string(), format!("Bearer {session_token}"))])
                } else {
                    Err(err)
                }
            }
        }
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
            ("Referer".to_string(), "https://www.iwara.tv/".to_string()),
            ("Origin".to_string(), "https://www.iwara.tv".to_string()),
        ];
        merged_headers.extend(self.session.headers_for(url).await.unwrap_or_default());
        merged_headers.extend(headers);
        let response = self.send_request(url, method, &merged_headers, body.clone()).await?;
        let content_type = response
            .headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case("content-type"))
            .map(|(_, value)| value.as_str())
            .unwrap_or("");
        let mut text = response.text;
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
        if !content_type.contains("application/json") && !text.trim_start().starts_with('{') && !text.trim_start().starts_with('[') {
            if looks_like_cloudflare(&text) {
                return Err(message("Iwara 返回了浏览器验证页面，请先在站点完成验证或稍后重试。"));
            }
            return Err(message(format!("Iwara 返回了非 JSON 内容：HTTP {}", response.status)));
        }
        let json = if text.trim().is_empty() {
            serde_json::from_str("{}")?
        } else {
            serde_json::from_str(&text)?
        };
        if !(200..300).contains(&response.status) {
            return Err(message(format!("Iwara API 请求失败：HTTP {}", response.status)));
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
            .map(|(name, value)| (name.as_str().to_string(), value.to_str().unwrap_or("").to_string()))
            .collect();
        let text = response.text().await?;
        Ok(SimpleResponse { status, headers, text })
    }

    async fn fetch_text(&self, url: &str, headers: Vec<(String, String)>) -> AppResult<String> {
        let mut merged_headers = vec![("Referer".to_string(), "https://www.iwara.tv/".to_string())];
        merged_headers.extend(self.session.headers_for(url).await.unwrap_or_default());
        merged_headers.extend(headers);
        let response = self.send_request(url, "GET", &merged_headers, None).await?;
        if !(200..300).contains(&response.status) {
            return Err(message(format!("Iwara 前端脚本请求失败：HTTP {}", response.status)));
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
            let labels = formats.iter().map(|format| format.label.clone()).collect::<Vec<_>>();
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
    query.map(|value| value.trim().to_string()).filter(|value| !value.is_empty())
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

fn matches_any_tag(video_tags: &[String], tags: &HashSet<String>) -> bool {
    if tags.is_empty() {
        return false;
    }
    let video_tags = video_tags.iter().map(|tag| tag.trim().to_lowercase()).collect::<HashSet<_>>();
    tags.iter().any(|tag| video_tags.contains(tag))
}

fn matches_all_tags(video_tags: &[String], tags: &HashSet<String>) -> bool {
    if tags.is_empty() {
        return true;
    }
    let video_tags = video_tags.iter().map(|tag| tag.trim().to_lowercase()).collect::<HashSet<_>>();
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
    let body = plain_text(raw.get("body").or_else(|| raw.get("comment")).or_else(|| raw.get("text")))?;
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
            return value_to_string(src.get("view"))
                .or_else(|| value_to_string(src.get("download")))
                .or_else(|| value_to_string(src.get("src")))
                .or_else(|| value_to_string(src.get("url")));
        }
    }
    value_to_string(value.get("view"))
        .or_else(|| value_to_string(value.get("download")))
        .or_else(|| value_to_string(value.get("url")))
}

fn value_to_string(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn thumbnail_url(file: &Value) -> Option<String> {
    value_to_string(file.get("id")).map(|file_id| format!("{FILES_BASE}/image/thumbnail/{file_id}/thumbnail-00.jpg"))
}

fn plain_text(value: Option<&Value>) -> Option<String> {
    let value = value?.as_str()?.trim();
    if value.is_empty() {
        return None;
    }
    let mut stripped = Regex::new(r"(?i)<br\s*/?>").unwrap().replace_all(value, "\n").to_string();
    stripped = Regex::new(r"(?i)</p>").unwrap().replace_all(&stripped, "\n").to_string();
    stripped = Regex::new(r"<[^>]+>").unwrap().replace_all(&stripped, "").to_string();
    stripped = stripped
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    stripped = Regex::new(r"\n{3,}").unwrap().replace_all(&stripped, "\n\n").trim().to_string();
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
            return Some((if number > 360_000.0 { number / 1000.0 } else { number }).round() as u64);
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
    formats.iter().map(|format| format.quality_rank).max().unwrap_or(0)
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
    if Regex::new(r"/main\.[\w-]+\.js").unwrap().is_match(url) {
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
        Value::Object(map) => format!("object({})", map.keys().cloned().collect::<Vec<_>>().join(", ")),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_tags_with_blocked_tags() {
        let videos = vec![
            crate::models::VideoSummary {
                id: "ok".to_string(),
                title: "ok".to_string(),
                description: None,
                uploader_id: None,
                uploader_name: None,
                uploader_username: None,
                thumbnail_url: None,
                rating: None,
                tags: vec!["breeding".to_string(), "koikatsu".to_string()],
                num_views: 0,
                num_likes: 0,
                num_comments: 0,
                duration_seconds: None,
                created_at: None,
                updated_at: None,
            },
        ];
        let required = ["breeding".to_string(), "koikatsu".to_string()]
            .into_iter()
            .collect::<HashSet<_>>();
        assert!(matches_all_tags(&videos[0].tags, &required));
        assert!(!matches_any_tag(&videos[0].tags, &["muted".to_string()].into_iter().collect()));
    }
}
