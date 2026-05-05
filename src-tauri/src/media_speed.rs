use std::collections::HashSet;

use regex::Regex;
use url::Url;

pub fn normalize_media_host_list(hosts: &[String]) -> Vec<String> {
    let pattern = Regex::new(r"(?i)^[a-z0-9-]+\.iwara\.tv$").unwrap();
    let mut seen = HashSet::new();
    let mut cleaned = Vec::new();

    for host in hosts {
        let mut value = host.trim().to_lowercase();
        value = value
            .trim_start_matches("http://")
            .trim_start_matches("https://")
            .split('/')
            .next()
            .unwrap_or("")
            .to_string();
        if pattern.is_match(&value) && seen.insert(value.clone()) {
            cleaned.push(value);
        }
    }

    cleaned
}

pub fn media_url_host(url: &str) -> Option<String> {
    Url::parse(&normalize_absolute_media_url(url))
        .ok()
        .and_then(|parsed| parsed.host_str().map(ToString::to_string))
}

pub fn build_media_host_candidates(url: &str, hosts: &[String]) -> Vec<(String, String)> {
    let mut seed = Vec::new();
    if let Some(original) = media_url_host(url) {
        seed.push(original);
    }
    seed.extend_from_slice(hosts);
    normalize_media_host_list(&seed)
        .into_iter()
        .filter_map(|host| replace_media_url_host(url, &host).map(|next_url| (host, next_url)))
        .collect()
}

pub fn replace_media_url_host(url: &str, host: &str) -> Option<String> {
    let mut parsed = Url::parse(&normalize_absolute_media_url(url)).ok()?;
    parsed.set_host(Some(host)).ok()?;
    Some(parsed.to_string())
}

fn normalize_absolute_media_url(url: &str) -> String {
    if url.starts_with("//") {
        format!("https:{url}")
    } else {
        url.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_safe_candidates() {
        assert_eq!(
            normalize_media_host_list(&[
                "https://jade.iwara.tv/view".to_string(),
                " kafka.iwara.tv ".to_string(),
                "example.com".to_string()
            ]),
            vec!["jade.iwara.tv".to_string(), "kafka.iwara.tv".to_string()]
        );
        assert_eq!(
            replace_media_url_host("//jade.iwara.tv/view?hash=abc&path=2026", "kafka.iwara.tv").as_deref(),
            Some("https://kafka.iwara.tv/view?hash=abc&path=2026")
        );
    }
}
