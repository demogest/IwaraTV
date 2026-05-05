use std::sync::Mutex;

use base64::Engine;
use keyring::Entry;
use serde_json::Value;

use crate::models::AuthState;

const SERVICE: &str = "IwaraTV";
const ACCOUNT: &str = "iwara-user-token";

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
struct PersistedAuth {
    email: String,
    user_token: String,
    #[serde(default)]
    username: Option<String>,
}

pub struct AuthStore {
    persisted: Mutex<Option<PersistedAuth>>,
    media_token: Mutex<Option<String>>,
}

impl AuthStore {
    pub fn new() -> Self {
        Self {
            persisted: Mutex::new(load_auth()),
            media_token: Mutex::new(None),
        }
    }

    pub fn get_user_token(&self) -> Option<String> {
        self.persisted
            .lock()
            .expect("auth mutex poisoned")
            .as_ref()
            .map(|auth| auth.user_token.clone())
    }

    pub fn get_media_token(&self) -> Option<String> {
        self.media_token.lock().expect("media token mutex poisoned").clone()
    }

    pub fn set_media_token(&self, token: String) {
        *self.media_token.lock().expect("media token mutex poisoned") = Some(token);
    }

    pub fn save_user_token(&self, email: String, user_token: String, username: Option<String>) {
        let persisted = PersistedAuth {
            email,
            user_token,
            username,
        };
        if let Ok(entry) = Entry::new(SERVICE, ACCOUNT) {
            if let Ok(payload) = serde_json::to_string(&persisted) {
                let _ = entry.set_password(&payload);
            }
        }
        *self.persisted.lock().expect("auth mutex poisoned") = Some(persisted);
    }

    pub fn clear(&self) {
        *self.persisted.lock().expect("auth mutex poisoned") = None;
        *self.media_token.lock().expect("media token mutex poisoned") = None;
        if let Ok(entry) = Entry::new(SERVICE, ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }

    pub fn state(&self) -> AuthState {
        let persisted = self.persisted.lock().expect("auth mutex poisoned").clone();
        let username = persisted
            .as_ref()
            .and_then(|auth| auth.username.clone().or_else(|| username_from_jwt(&auth.user_token)));
        AuthState {
            logged_in: persisted.as_ref().is_some_and(|auth| !auth.user_token.is_empty()),
            email: persisted.as_ref().map(|auth| auth.email.clone()),
            username,
            has_media_token: self.get_media_token().is_some(),
            encryption_available: encryption_available(),
            site_session_ready: None,
            site_cookie_count: None,
            site_token_ready: None,
            site_token_key: None,
            browser_user_agent: None,
            warning: if encryption_available() {
                None
            } else {
                Some("系统安全存储不可用，本次登录不会持久化到磁盘。".to_string())
            },
        }
    }
}

pub fn is_jwt_expired(token: &str, skew_seconds: u64) -> bool {
    let Some(json) = jwt_payload(token) else {
        return false;
    };
    let Some(exp) = json.get("exp").and_then(|value| value.as_u64()) else {
        return false;
    };
    exp <= current_unix_seconds() + skew_seconds
}

pub fn username_from_jwt(token: &str) -> Option<String> {
    jwt_claim_string(
        token,
        &[
            "username",
            "name",
            "preferred_username",
            "displayName",
            "display_name",
            "nickname",
            "user.username",
            "user.name",
            "profile.username",
            "profile.name",
        ],
    )
}

pub fn jwt_claim_string(token: &str, keys: &[&str]) -> Option<String> {
    let payload = jwt_payload(token)?;
    keys.iter()
        .find_map(|key| value_at_path(&payload, key).and_then(non_empty_string))
}

fn jwt_payload(token: &str) -> Option<Value> {
    let mut parts = token.split('.');
    let _header = parts.next();
    let payload = parts.next()?;
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    serde_json::from_slice::<Value>(&decoded).ok()
}

fn value_at_path<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    path.split('.').try_fold(value, |current, key| current.get(key))
}

fn non_empty_string(value: &Value) -> Option<String> {
    match value {
        Value::String(value) => {
            let value = value.trim();
            if value.is_empty() {
                None
            } else {
                Some(value.to_string())
            }
        }
        Value::Number(value) => Some(value.to_string()),
        _ => None,
    }
}

fn load_auth() -> Option<PersistedAuth> {
    let entry = Entry::new(SERVICE, ACCOUNT).ok()?;
    let payload = entry.get_password().ok()?;
    serde_json::from_str(&payload).ok()
}

fn encryption_available() -> bool {
    Entry::new(SERVICE, ACCOUNT).is_ok()
}

fn current_unix_seconds() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
