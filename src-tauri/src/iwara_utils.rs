use std::sync::OnceLock;

use regex::Regex;
use sha1::{Digest, Sha1};
use url::Url;

use crate::error::{message, AppResult};
use crate::models::VideoFormat;

pub const DEFAULT_X_VERSION_SALT: &str = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";

pub fn parse_iwara_video_id(input: &str) -> AppResult<String> {
    let trimmed = input.trim();
    if video_id_pattern().is_match(trimmed) {
        return Ok(trimmed.to_string());
    }

    if let Some(captures) = video_url_pattern().captures(trimmed) {
        if let Some(value) = captures.get(1) {
            return Ok(value.as_str().to_string());
        }
    }

    Err(message("无法识别 Iwara 视频 ID 或链接。"))
}

pub fn build_x_version(file_url: &str, salt: Option<&str>) -> AppResult<String> {
    let parsed = Url::parse(file_url)?;
    let expires = parsed
        .query_pairs()
        .find(|(key, _)| key == "expires")
        .map(|(_, value)| value.to_string())
        .ok_or_else(|| message("Iwara fileUrl 缺少生成 X-Version 所需的参数。"))?;
    let file_id = parsed
        .path_segments()
        .and_then(|mut parts| parts.next_back())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| message("Iwara fileUrl 缺少生成 X-Version 所需的参数。"))?;
    let payload = format!(
        "{}_{}_{}",
        file_id,
        expires,
        salt.unwrap_or(DEFAULT_X_VERSION_SALT)
    );
    let digest = Sha1::digest(payload.as_bytes());
    Ok(format!("{digest:x}"))
}

pub fn extract_x_version_salt_from_script(script: &str) -> Option<String> {
    let mut candidates = Vec::new();
    for captures in salt_pattern().captures_iter(script) {
        let Some(matched) = captures.get(1) else {
            continue;
        };
        let salt = matched.as_str();
        if salt.chars().any(|c| c.is_ascii_uppercase())
            && salt.chars().any(|c| c.is_ascii_lowercase())
            && salt.chars().any(|c| c.is_ascii_digit())
        {
            candidates.push((salt.to_string(), matched.start()));
        }
    }

    candidates
        .into_iter()
        .map(|(salt, index)| {
            let start = index.saturating_sub(1200);
            let end = (index + 1600).min(script.len());
            let context = &script[start..end];
            let score = [
                "X-Version",
                "fileUrl",
                "expires",
                "SHA-1",
                "crypto.subtle.digest",
            ]
            .iter()
            .filter(|needle| context.contains(**needle))
            .count();
            (salt, score)
        })
        .max_by(|(left_salt, left_score), (right_salt, right_score)| {
            left_score
                .cmp(right_score)
                .then(left_salt.len().cmp(&right_salt.len()))
        })
        .map(|(salt, _)| salt)
}

pub fn with_iwara_download_name(file_url: &str, title: &str, video_id: &str) -> AppResult<String> {
    let mut parsed = Url::parse(file_url)?;
    parsed
        .query_pairs_mut()
        .append_pair("download", &format!("Iwara - {title} [{video_id}].mp4"));
    Ok(parsed.to_string())
}

pub fn normalize_media_url(value: &str) -> String {
    if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value.to_string()
    }
}

pub fn quality_rank(label: &str) -> u64 {
    let normalized = label.to_lowercase();
    if normalized == "source" {
        return 4000;
    }
    if normalized == "preview" {
        return 1;
    }

    normalized.parse::<u64>().unwrap_or(0)
}

pub fn choose_video_format(
    formats: &[VideoFormat],
    preferred_quality: Option<&str>,
) -> Option<VideoFormat> {
    if let Some(preferred_quality) = preferred_quality {
        if let Some(found) = formats
            .iter()
            .find(|format| format.id == preferred_quality || format.label == preferred_quality)
        {
            return Some(found.clone());
        }
    }

    formats
        .iter()
        .max_by_key(|format| format.quality_rank)
        .cloned()
}

pub fn format_to_extension(mime_type: Option<&str>) -> Option<String> {
    let mime_type = mime_type?;
    if mime_type.contains("mp4") {
        Some("mp4".to_string())
    } else if mime_type.contains("webm") {
        Some("webm".to_string())
    } else {
        None
    }
}

fn video_id_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| Regex::new(r"^[a-zA-Z0-9]{6,}$").expect("valid Iwara video id regex"))
}

fn video_url_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r"(?i)iwara\.tv/videos?/([a-zA-Z0-9]+)").expect("valid Iwara video URL regex")
    })
}

fn salt_pattern() -> &'static Regex {
    static PATTERN: OnceLock<Regex> = OnceLock::new();
    PATTERN.get_or_init(|| {
        Regex::new(r#"["_]([A-Za-z0-9]{20,80})["']"#).expect("valid X-Version salt regex")
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ids_and_urls() {
        assert_eq!(parse_iwara_video_id("abc123XYZ").unwrap(), "abc123XYZ");
        assert_eq!(
            parse_iwara_video_id("https://www.iwara.tv/video/7rr1s5u30B2RtG/title").unwrap(),
            "7rr1s5u30B2RtG"
        );
    }

    #[test]
    fn builds_x_version_hash() {
        let hash = build_x_version(
            "https://files.iwara.tv/file/video-file-id?expires=1700000000",
            None,
        )
        .unwrap();
        assert_eq!(hash, "6fedab7f968b4133d7a3857bbb9567799185b222");
    }

    #[test]
    fn sniffs_salt() {
        let salt = "mSvL05GfEmeEmsEYfGCnVpEjYgTJraJN";
        let script =
            format!(r#"const h = SHA1(fileUrl + expires + "_{salt}"); headers["X-Version"] = h;"#);
        assert_eq!(
            extract_x_version_salt_from_script(&script).as_deref(),
            Some(salt)
        );
    }
}
