use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;
use tokio::time::{sleep, timeout};
use url::Url;

use crate::error::{message, AppResult};
use crate::iwara_client::{summarize_json_response, SimpleResponse};
use crate::models::{AuthState, IwaraNetworkCapture, IwaraNetworkEntry};

const IWARA_HOME: &str = "https://www.iwara.tv/";
const IWARA_ORIGINS: [&str; 4] = [
    "https://www.iwara.tv/",
    "https://api.iwara.tv/",
    "https://files.iwara.tv/",
    "https://filesq.iwara.tv/",
];
const BROWSER_USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

pub struct IwaraSessionService {
    app: AppHandle,
    verification_label: Mutex<Option<String>>,
    page_fetch_label: Mutex<Option<String>>,
    captured_token: Mutex<Option<CapturedToken>>,
}

impl IwaraSessionService {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            verification_label: Mutex::new(None),
            page_fetch_label: Mutex::new(None),
            captured_token: Mutex::new(None),
        }
    }

    pub async fn open_verification_window(self: &Arc<Self>) -> AppResult<AuthState> {
        if let Some(window) = self.current_verification_window() {
            let _ = window.set_focus();
            return self.state().await;
        }

        let label = "iwara-verification".to_string();
        let window = WebviewWindowBuilder::new(
            &self.app,
            &label,
            WebviewUrl::External(Url::parse(IWARA_HOME)?),
        )
        .title("Iwara 验证")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .background_color(tauri::webview::Color(0x11, 0x13, 0x17, 0xff))
        .user_agent(BROWSER_USER_AGENT)
        .build()?;
        *self.verification_label.lock().expect("verification mutex poisoned") = Some(label);

        let service = Arc::clone(self);
        tokio::spawn(async move {
            for _ in 0..45 {
                if let Ok(Some(token)) = service.capture_token_from_window(&window).await {
                    *service.captured_token.lock().expect("token mutex poisoned") = Some(token);
                    sleep(Duration::from_millis(800)).await;
                    let _ = window.close();
                    break;
                }
                sleep(Duration::from_millis(1500)).await;
            }
        });

        self.state().await
    }

    pub async fn state(&self) -> AppResult<AuthState> {
        let cookies = self.iwara_cookies().await.unwrap_or_default();
        let token = self.capture_token().await?;
        Ok(AuthState {
            logged_in: false,
            email: None,
            has_media_token: false,
            encryption_available: true,
            site_session_ready: Some(!cookies.is_empty()),
            site_cookie_count: Some(cookies.len()),
            site_token_ready: Some(token.as_ref().is_some_and(|token| !token.value.is_empty())),
            site_token_key: token.map(|token| token.key),
            browser_user_agent: Some(BROWSER_USER_AGENT.to_string()),
            warning: None,
        })
    }

    pub async fn headers_for(&self, url: &str) -> AppResult<Vec<(String, String)>> {
        let cookie_header = self.cookie_header_for(url).await?;
        let token = self.session_token().await?;
        let mut headers = vec![
            ("User-Agent".to_string(), BROWSER_USER_AGENT.to_string()),
            ("Accept-Language".to_string(), "zh-CN,zh;q=0.9,en;q=0.8".to_string()),
        ];
        if let Some(token) = token {
            headers.push(("Authorization".to_string(), format!("Bearer {}", token.value)));
        }
        if let Some(cookie_header) = cookie_header {
            headers.push(("Cookie".to_string(), cookie_header));
        }
        Ok(headers)
    }

    pub async fn token(&self) -> AppResult<Option<String>> {
        Ok(self.session_token().await?.map(|token| token.value))
    }

    pub fn can_use_iwara_page_fetch(&self, url: &str, headers: &[(String, String)]) -> bool {
        is_relevant_iwara_api_url(url)
            && headers
                .iter()
                .find(|(key, _)| key.eq_ignore_ascii_case("accept"))
                .map(|(_, value)| value.to_lowercase().contains("application/json"))
                .unwrap_or(false)
    }

    pub async fn fetch_inside_iwara_page(
        &self,
        url: &str,
        method: &str,
        headers: &[(String, String)],
        body: Option<String>,
    ) -> AppResult<SimpleResponse> {
        let window = self.ensure_page_fetch_window().await?;
        let safe_headers = headers
            .iter()
            .filter(|(name, _)| !is_forbidden_browser_fetch_header(name))
            .cloned()
            .collect::<Vec<_>>();
        let request_id = format!("fetch-{}", crate::iwara_client::now_iso_string());
        let payload = serde_json::json!({
            "url": url,
            "method": method,
            "headers": safe_headers,
            "body": body
        });
        let js = format!(
            r#"(() => {{
              const requestId = {};
              window.__iwaraTVFetchResults = window.__iwaraTVFetchResults || {{}};
              window.__iwaraTVFetchResults[requestId] = null;
              (async (request) => {{
                try {{
                const response = await fetch(request.url, {{
                  method: request.method,
                  headers: Object.fromEntries(request.headers),
                  body: request.body || undefined,
                  credentials: "include",
                  mode: "cors"
                }});
                window.__iwaraTVFetchResults[requestId] = {{
                  ok: true,
                  result: {{
                  status: response.status,
                  headers: Array.from(response.headers.entries()),
                  text: await response.text()
                  }}
                }};
                }} catch (err) {{
                  window.__iwaraTVFetchResults[requestId] = {{
                    ok: false,
                    error: String(err && err.message ? err.message : err)
                  }};
                }}
              }})({});
            }})()"#,
            serde_json::to_string(&request_id)?,
            serde_json::to_string(&payload)?
        );
        window.eval(js)?;
        let result = self.poll_fetch_result(&window, &request_id).await?;
        if let Some(token) = self.capture_token_from_window(&window).await? {
            *self.captured_token.lock().expect("token mutex poisoned") = Some(token);
        }
        Ok(SimpleResponse {
            status: result.status,
            headers: result.headers,
            text: result.text,
        })
    }

    pub async fn capture_video_network(&self, id_or_url: &str) -> AppResult<IwaraNetworkCapture> {
        let video_id = crate::iwara_utils::parse_iwara_video_id(id_or_url)?;
        let page_url = format!("https://www.iwara.tv/video/{video_id}");
        let label = format!("iwara-diagnostics-{video_id}");
        let init = diagnostics_script();
        let window = WebviewWindowBuilder::new(
            &self.app,
            &label,
            WebviewUrl::External(Url::parse(&page_url)?),
        )
        .title("Iwara API 抓包诊断")
        .inner_size(1180.0, 820.0)
        .min_inner_size(900.0, 640.0)
        .background_color(tauri::webview::Color(0x11, 0x13, 0x17, 0xff))
        .user_agent(BROWSER_USER_AGENT)
        .initialization_script(&init)
        .build()?;

        let _ = window.with_webview(|_platform_webview| {
            // Keep WebView2 access explicit and pinned through Tauri for this diagnostics surface.
        });

        let mut timed_out = true;
        let mut entries = Vec::new();
        for _ in 0..18 {
            sleep(Duration::from_secs(1)).await;
            entries = self.read_network_entries(&window).await.unwrap_or_default();
            if entries.iter().any(|entry| !entry.format_labels.is_empty()) {
                timed_out = false;
                sleep(Duration::from_millis(1200)).await;
                let _ = window.close();
                break;
            }
        }
        let _ = window.close();

        Ok(IwaraNetworkCapture {
            page_url,
            entries,
            timed_out,
        })
    }

    async fn cookie_header_for(&self, url: &str) -> AppResult<Option<String>> {
        let mut urls = vec![url.to_string()];
        urls.extend(IWARA_ORIGINS.iter().map(|value| value.to_string()));
        urls.sort();
        urls.dedup();

        let window = self.ensure_page_fetch_window().await?;
        let mut cookies = Vec::new();
        for cookie_url in urls {
            let parsed = Url::parse(&cookie_url).or_else(|_| Url::parse(IWARA_HOME))?;
            if let Ok(values) = window.cookies_for_url(parsed) {
                for cookie in values {
                    cookies.push((cookie.name().to_string(), cookie.value().to_string()));
                }
            }
        }
        cookies.sort_by(|a, b| a.0.cmp(&b.0));
        cookies.dedup_by(|a, b| a.0 == b.0);
        Ok(if cookies.is_empty() {
            None
        } else {
            Some(
                cookies
                    .into_iter()
                    .map(|(name, value)| format!("{name}={value}"))
                    .collect::<Vec<_>>()
                    .join("; "),
            )
        })
    }

    async fn iwara_cookies(&self) -> AppResult<Vec<(String, String)>> {
        let window = self.ensure_page_fetch_window().await?;
        let mut cookies = Vec::new();
        for url in IWARA_ORIGINS {
            let parsed = Url::parse(url)?;
            if let Ok(values) = window.cookies_for_url(parsed) {
                cookies.extend(values.into_iter().map(|cookie| (cookie.name().to_string(), cookie.value().to_string())));
            }
        }
        Ok(cookies)
    }

    async fn capture_token(&self) -> AppResult<Option<CapturedToken>> {
        if let Some(window) = self.current_verification_window().or_else(|| self.current_page_fetch_window()) {
            if let Some(token) = self.capture_token_from_window(&window).await? {
                *self.captured_token.lock().expect("token mutex poisoned") = Some(token.clone());
                return Ok(Some(token));
            }
        }
        Ok(self.captured_token.lock().expect("token mutex poisoned").clone())
    }

    async fn session_token(&self) -> AppResult<Option<CapturedToken>> {
        if let Some(token) = self.capture_token().await? {
            return Ok(Some(token));
        }
        if !self.iwara_cookies().await?.is_empty() {
            let window = self.ensure_page_fetch_window().await?;
            if let Some(token) = self.capture_token_from_window(&window).await? {
                *self.captured_token.lock().expect("token mutex poisoned") = Some(token.clone());
                return Ok(Some(token));
            }
        }
        Ok(None)
    }

    async fn ensure_page_fetch_window(&self) -> AppResult<WebviewWindow> {
        if let Some(window) = self.current_verification_window().or_else(|| self.current_page_fetch_window()) {
            return Ok(window);
        }

        let label = "iwara-page-fetch".to_string();
        let window = WebviewWindowBuilder::new(
            &self.app,
            &label,
            WebviewUrl::External(Url::parse(IWARA_HOME)?),
        )
        .title("Iwara 会话请求")
        .inner_size(960.0, 640.0)
        .visible(false)
        .user_agent(BROWSER_USER_AGENT)
        .build()?;
        *self.page_fetch_label.lock().expect("page fetch mutex poisoned") = Some(label);
        sleep(Duration::from_millis(800)).await;
        if let Some(token) = self.capture_token_from_window(&window).await? {
            *self.captured_token.lock().expect("token mutex poisoned") = Some(token);
        }
        Ok(window)
    }

    async fn capture_token_from_window(&self, target: &WebviewWindow) -> AppResult<Option<CapturedToken>> {
        let js = r#"(() => {
          const dump = (storage) => {
            const entries = {};
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              if (key) entries[key] = storage.getItem(key);
            }
            return entries;
          };
          return {
            localStorage: dump(window.localStorage),
            sessionStorage: dump(window.sessionStorage)
          };
        })()"#;
        let storage: StorageDump = eval_json(target, js.to_string()).await?;
        Ok(find_token(storage))
    }

    async fn read_network_entries(&self, window: &WebviewWindow) -> AppResult<Vec<IwaraNetworkEntry>> {
        let raw: Vec<CapturedNetworkEntry> = eval_json(
            window,
            r#"(() => Array.isArray(window.__iwaraTVNetworkEntries) ? window.__iwaraTVNetworkEntries : [])()"#.to_string(),
        )
        .await?;
        Ok(raw
            .into_iter()
            .filter(|entry| is_relevant_iwara_api_url(&entry.url))
            .map(|entry| {
                let (format_labels, formats, response_shape) = entry
                    .body
                    .as_deref()
                    .map(summarize_json_response)
                    .unwrap_or_else(|| (Vec::new(), None, "unknown".to_string()));
                IwaraNetworkEntry {
                    url: safe_url(&entry.url),
                    method: entry.method.unwrap_or_else(|| "GET".to_string()),
                    status: entry.status,
                    resource_type: entry.resource_type,
                    format_labels,
                    formats,
                    x_version: entry.x_version,
                    has_authorization: entry.has_authorization,
                    response_shape: Some(response_shape),
                    error: entry.error,
                }
            })
            .collect())
    }

    async fn poll_fetch_result(&self, window: &WebviewWindow, request_id: &str) -> AppResult<BrowserFetchResult> {
        let request_id_json = serde_json::to_string(request_id)?;
        for _ in 0..75 {
            let js = format!(
                r#"(() => {{
                  const results = window.__iwaraTVFetchResults || {{}};
                  return results[{}] || null;
                }})()"#,
                request_id_json
            );
            let slot: Option<AsyncBrowserFetchResult> = eval_json(window, js).await?;
            if let Some(slot) = slot {
                if slot.ok {
                    return slot.result.ok_or_else(|| message("WebView 页面请求没有返回结果。"));
                }
                return Err(message(slot.error.unwrap_or_else(|| "WebView 页面请求失败。".to_string())));
            }
            sleep(Duration::from_millis(200)).await;
        }
        Err(message("WebView 页面请求超时。"))
    }

    fn current_verification_window(&self) -> Option<WebviewWindow> {
        let label = self.verification_label.lock().expect("verification mutex poisoned").clone()?;
        self.app.get_webview_window(&label)
    }

    fn current_page_fetch_window(&self) -> Option<WebviewWindow> {
        let label = self.page_fetch_label.lock().expect("page fetch mutex poisoned").clone()?;
        self.app.get_webview_window(&label)
    }
}

async fn eval_json<T: for<'de> Deserialize<'de>>(window: &WebviewWindow, js: String) -> AppResult<T> {
    let (tx, rx) = oneshot::channel();
    let tx = Arc::new(Mutex::new(Some(tx)));
    window.eval_with_callback(js, move |result| {
        if let Some(tx) = tx.lock().expect("eval callback mutex poisoned").take() {
            let _ = tx.send(result);
        }
    })?;
    let raw = timeout(Duration::from_secs(15), rx)
        .await
        .map_err(|_| message("WebView JavaScript 执行超时。"))?
        .map_err(|_| message("WebView JavaScript 回调已取消。"))?;
    serde_json::from_str(&raw).map_err(Into::into)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturedToken {
    key: String,
    value: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageDump {
    #[serde(default)]
    local_storage: std::collections::HashMap<String, Option<String>>,
    #[serde(default)]
    session_storage: std::collections::HashMap<String, Option<String>>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFetchResult {
    status: u16,
    headers: Vec<(String, String)>,
    text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AsyncBrowserFetchResult {
    ok: bool,
    #[serde(default)]
    result: Option<BrowserFetchResult>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapturedNetworkEntry {
    url: String,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    status: Option<u16>,
    #[serde(default)]
    resource_type: Option<String>,
    #[serde(default)]
    body: Option<String>,
    #[serde(default)]
    x_version: Option<String>,
    #[serde(default)]
    has_authorization: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

fn find_token(storage: StorageDump) -> Option<CapturedToken> {
    let mut entries = Vec::new();
    for (key, value) in storage.local_storage {
        entries.push((format!("localStorage.{key}"), value));
    }
    for (key, value) in storage.session_storage {
        entries.push((format!("sessionStorage.{key}"), value));
    }
    let preferred = ["token", "accessToken", "access_token", "authToken", "userToken"];

    for preferred_key in preferred {
        if let Some((key, value)) = entries.iter().find(|(key, value)| {
            key.to_lowercase().ends_with(&format!(".{}", preferred_key.to_lowercase()))
                && find_jwt(value.as_deref()).is_some()
        }) {
            return Some(CapturedToken {
                key: key.clone(),
                value: find_jwt(value.as_deref())?,
            });
        }
    }

    entries.into_iter().find_map(|(key, value)| {
        find_jwt(value.as_deref()).map(|token| CapturedToken { key, value: token })
    })
}

fn find_jwt(value: Option<&str>) -> Option<String> {
    let value = value?;
    let direct = regex::Regex::new(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+")
        .ok()?
        .find(value)
        .map(|found| found.as_str().to_string());
    if direct.is_some() {
        return direct;
    }
    serde_json::from_str::<Value>(value)
        .ok()
        .and_then(|json| find_jwt(Some(&json.to_string())))
}

fn diagnostics_script() -> String {
    r#"
      (() => {
        const relevant = (url) => {
          try {
            const host = new URL(url, location.href).hostname;
            return host === "api.iwara.tv" || host === "files.iwara.tv" || host === "filesq.iwara.tv";
          } catch {
            return false;
          }
        };
        const pushEntry = async (entry, response) => {
          try {
            if (response) {
              entry.status = response.status;
              entry.resourceType = response.headers.get("content-type") || undefined;
              entry.body = await response.clone().text();
            }
          } catch (err) {
            entry.error = String(err && err.message ? err.message : err);
          }
          window.__iwaraTVNetworkEntries = window.__iwaraTVNetworkEntries || [];
          window.__iwaraTVNetworkEntries.push(entry);
        };
        window.__iwaraTVNetworkEntries = [];
        const originalFetch = window.fetch;
        window.fetch = async (...args) => {
          const input = args[0];
          const init = args[1] || {};
          const url = typeof input === "string" ? input : input && input.url;
          const method = init.method || (input && input.method) || "GET";
          const response = await originalFetch(...args);
          if (url && relevant(url)) {
            let xVersion;
            let hasAuthorization = false;
            try {
              const headers = new Headers(init.headers || (input && input.headers) || {});
              xVersion = headers.get("x-version") || undefined;
              hasAuthorization = Boolean(headers.get("authorization"));
            } catch {}
            pushEntry({ url: new URL(url, location.href).toString(), method, xVersion, hasAuthorization }, response);
          }
          return response;
        };
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this.__iwaraTVRequest = { method, url: new URL(url, location.href).toString() };
          return originalOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function(...args) {
          this.addEventListener("loadend", () => {
            const request = this.__iwaraTVRequest;
            if (!request || !relevant(request.url)) return;
            const entry = {
              url: request.url,
              method: request.method || "GET",
              status: this.status,
              resourceType: this.getResponseHeader("content-type") || undefined,
              body: this.responseText
            };
            window.__iwaraTVNetworkEntries.push(entry);
          });
          return originalSend.apply(this, args);
        };
      })();
    "#
    .to_string()
}

fn is_relevant_iwara_api_url(url: &str) -> bool {
    Url::parse(url)
        .ok()
        .and_then(|parsed| parsed.host_str().map(|host| {
            host == "api.iwara.tv" || host == "files.iwara.tv" || host == "filesq.iwara.tv"
        }))
        .unwrap_or(false)
}

fn is_forbidden_browser_fetch_header(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "cookie" | "host" | "origin" | "referer" | "user-agent" | "content-length"
    )
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
