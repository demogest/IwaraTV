use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::AppResult;
use crate::iwara_client::now_iso_string;
use crate::models::{
    FavoriteFileResult, FavoriteImportResult, FavoriteItem, FavoriteState, VideoSummary,
};

const FAVORITES_SCHEMA_VERSION: u64 = 1;

pub struct FavoriteStore {
    file_path: PathBuf,
    items: Mutex<Vec<FavoriteItem>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteExportFile {
    schema_version: u64,
    exported_at: String,
    items: Vec<FavoriteItem>,
}

impl FavoriteStore {
    pub fn new(user_data_path: &Path) -> Self {
        let file_path = user_data_path.join("favorites.json");
        let items = load_favorite_items(&file_path);
        Self {
            file_path,
            items: Mutex::new(items),
        }
    }

    pub fn state(&self) -> FavoriteState {
        FavoriteState {
            items: self.items.lock().expect("favorite mutex poisoned").clone(),
        }
    }

    pub fn add(&self, video: VideoSummary) -> AppResult<FavoriteState> {
        let next = {
            let mut items = self.items.lock().expect("favorite mutex poisoned");
            upsert_favorite(&mut items, favorite_item(video));
            FavoriteState {
                items: items.clone(),
            }
        };
        self.save(&next.items)?;
        Ok(next)
    }

    pub fn remove(&self, video_id: &str) -> AppResult<FavoriteState> {
        let next = {
            let mut items = self.items.lock().expect("favorite mutex poisoned");
            items.retain(|item| item.video.id != video_id);
            FavoriteState {
                items: items.clone(),
            }
        };
        self.save(&next.items)?;
        Ok(next)
    }

    pub fn backup(&self) -> AppResult<FavoriteFileResult> {
        let path = self.backup_path();
        self.export_to_path(&path)
    }

    pub fn export_to_path(&self, path: &Path) -> AppResult<FavoriteFileResult> {
        let items = self.items.lock().expect("favorite mutex poisoned").clone();
        persist_favorite_export(path, &items)?;
        Ok(FavoriteFileResult {
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            count: items.len(),
        })
    }

    pub fn import_from_path(&self, path: &Path) -> AppResult<FavoriteImportResult> {
        let incoming = load_favorites_file(path)?;
        let mut imported = 0;
        let mut merged = 0;
        let mut skipped = 0;
        let next = {
            let mut items = self.items.lock().expect("favorite mutex poisoned");
            let mut pending_new = Vec::new();
            for item in incoming {
                let Some(item) = normalize_favorite_item(item) else {
                    skipped += 1;
                    continue;
                };
                if let Some(current) = items
                    .iter_mut()
                    .find(|current| current.video.id == item.video.id)
                {
                    merge_favorite_item(current, item);
                    merged += 1;
                } else {
                    pending_new.push(item);
                    imported += 1;
                }
            }
            for item in pending_new.into_iter().rev() {
                items.insert(0, item);
            }
            FavoriteState {
                items: items.clone(),
            }
        };
        self.save(&next.items)?;
        Ok(FavoriteImportResult {
            canceled: false,
            path: Some(path.to_string_lossy().to_string()),
            imported,
            merged,
            skipped,
            total: next.items.len(),
            state: next,
        })
    }

    fn backup_path(&self) -> PathBuf {
        self.file_path.with_file_name("favorites.backup.json")
    }

    fn save(&self, items: &[FavoriteItem]) -> AppResult<()> {
        persist_favorite_state(&self.file_path, items)
    }
}

fn favorite_item(video: VideoSummary) -> FavoriteItem {
    FavoriteItem {
        video,
        favorited_at: now_iso_string(),
        note: None,
    }
}

fn upsert_favorite(items: &mut Vec<FavoriteItem>, item: FavoriteItem) {
    if let Some(index) = items
        .iter()
        .position(|current| current.video.id == item.video.id)
    {
        let mut existing = items.remove(index);
        existing.video = item.video;
        if existing.note.is_none() {
            existing.note = item.note;
        }
        items.insert(0, existing);
    } else {
        items.insert(0, item);
    }
}

fn load_favorite_items(path: &Path) -> Vec<FavoriteItem> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| parse_favorites(&raw).ok())
        .map(dedupe_favorites)
        .unwrap_or_default()
}

fn load_favorites_file(path: &Path) -> AppResult<Vec<FavoriteItem>> {
    let raw = fs::read_to_string(path)?;
    Ok(dedupe_favorites(parse_favorites(&raw)?))
}

fn parse_favorites(raw: &str) -> AppResult<Vec<FavoriteItem>> {
    if let Ok(export) = serde_json::from_str::<FavoriteExportFile>(raw) {
        return Ok(export.items);
    }
    if let Ok(state) = serde_json::from_str::<FavoriteState>(raw) {
        return Ok(state.items);
    }
    Ok(serde_json::from_str::<Vec<FavoriteItem>>(raw)?)
}

fn dedupe_favorites(items: Vec<FavoriteItem>) -> Vec<FavoriteItem> {
    let mut seen = HashSet::new();
    let mut normalized = Vec::new();
    for item in items {
        let Some(item) = normalize_favorite_item(item) else {
            continue;
        };
        if seen.insert(item.video.id.clone()) {
            normalized.push(item);
        }
    }
    normalized
}

fn normalize_favorite_item(mut item: FavoriteItem) -> Option<FavoriteItem> {
    item.video.id = item.video.id.trim().to_string();
    item.video.title = item.video.title.trim().to_string();
    if item.video.id.is_empty() {
        return None;
    }
    if item.video.title.is_empty() {
        item.video.title = item.video.id.clone();
    }
    if item.favorited_at.trim().is_empty() {
        item.favorited_at = now_iso_string();
    }
    Some(item)
}

fn merge_favorite_item(current: &mut FavoriteItem, incoming: FavoriteItem) {
    if incoming.favorited_at < current.favorited_at {
        current.favorited_at = incoming.favorited_at;
    }
    if current.note.is_none() {
        current.note = incoming.note;
    }
    current.video = merge_video_summary(current.video.clone(), incoming.video);
}

fn merge_video_summary(mut current: VideoSummary, incoming: VideoSummary) -> VideoSummary {
    if current.title.trim().is_empty() {
        current.title = incoming.title;
    }
    if current.description.is_none() {
        current.description = incoming.description;
    }
    if current.uploader_id.is_none() {
        current.uploader_id = incoming.uploader_id;
    }
    if current.uploader_name.is_none() {
        current.uploader_name = incoming.uploader_name;
    }
    if current.uploader_username.is_none() {
        current.uploader_username = incoming.uploader_username;
    }
    if current.uploader_avatar_url.is_none() {
        current.uploader_avatar_url = incoming.uploader_avatar_url;
    }
    if current.uploader_following.is_none() {
        current.uploader_following = incoming.uploader_following;
    }
    if current.thumbnail_url.is_none() {
        current.thumbnail_url = incoming.thumbnail_url;
    }
    if current.rating.is_none() {
        current.rating = incoming.rating;
    }
    if current.tags.is_empty() {
        current.tags = incoming.tags;
    }
    if current.num_views == 0 {
        current.num_views = incoming.num_views;
    }
    if current.num_likes == 0 {
        current.num_likes = incoming.num_likes;
    }
    if current.num_comments == 0 {
        current.num_comments = incoming.num_comments;
    }
    if current.duration_seconds.is_none() {
        current.duration_seconds = incoming.duration_seconds;
    }
    if current.created_at.is_none() {
        current.created_at = incoming.created_at;
    }
    if current.updated_at.is_none() {
        current.updated_at = incoming.updated_at;
    }
    current
}

fn persist_favorite_state(path: &Path, items: &[FavoriteItem]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let state = FavoriteState {
        items: items.to_vec(),
    };
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(&state)?))?;
    Ok(())
}

fn persist_favorite_export(path: &Path, items: &[FavoriteItem]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let export = FavoriteExportFile {
        schema_version: FAVORITES_SCHEMA_VERSION,
        exported_at: now_iso_string(),
        items: items.to_vec(),
    };
    fs::write(
        path,
        format!("{}\n", serde_json::to_string_pretty(&export)?),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_deduplicates_and_refreshes_video_metadata() {
        let dir = temp_dir("add-deduplicates");
        let store = FavoriteStore::new(&dir);

        let first = store.add(video("a", "First")).expect("add first");
        let favorited_at = first.items[0].favorited_at.clone();
        let second = store.add(video("a", "Second")).expect("add second");

        assert_eq!(second.items.len(), 1);
        assert_eq!(second.items[0].favorited_at, favorited_at);
        assert_eq!(second.items[0].video.title, "Second");

        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn import_merges_duplicates_and_adds_new_items() {
        let dir = temp_dir("import-merges");
        let store = FavoriteStore::new(&dir);
        store.add(video("a", "Local")).expect("add local");
        let import_path = dir.join("import.json");
        let import = FavoriteExportFile {
            schema_version: FAVORITES_SCHEMA_VERSION,
            exported_at: "2020-01-01T00:00:00Z".to_string(),
            items: vec![
                FavoriteItem {
                    video: video_with_uploader("a", "Incoming", "Uploader"),
                    favorited_at: "2020-01-01T00:00:00Z".to_string(),
                    note: Some("keep".to_string()),
                },
                FavoriteItem {
                    video: video("b", "New"),
                    favorited_at: "2021-01-01T00:00:00Z".to_string(),
                    note: None,
                },
            ],
        };
        fs::write(
            &import_path,
            serde_json::to_string_pretty(&import).expect("serialize import"),
        )
        .expect("write import");

        let report = store.import_from_path(&import_path).expect("import");

        assert_eq!(report.imported, 1);
        assert_eq!(report.merged, 1);
        assert_eq!(report.total, 2);
        let merged = report
            .state
            .items
            .iter()
            .find(|item| item.video.id == "a")
            .expect("merged item");
        assert_eq!(merged.favorited_at, "2020-01-01T00:00:00Z");
        assert_eq!(merged.video.title, "Local");
        assert_eq!(merged.video.uploader_name.as_deref(), Some("Uploader"));
        assert_eq!(merged.note.as_deref(), Some("keep"));

        let _ = fs::remove_dir_all(dir);
    }

    fn video(id: &str, title: &str) -> VideoSummary {
        VideoSummary {
            id: id.to_string(),
            title: title.to_string(),
            description: None,
            uploader_id: None,
            uploader_name: None,
            uploader_username: None,
            uploader_avatar_url: None,
            uploader_following: None,
            thumbnail_url: None,
            rating: None,
            tags: Vec::new(),
            num_views: 0,
            num_likes: 0,
            num_comments: 0,
            duration_seconds: None,
            created_at: None,
            updated_at: None,
        }
    }

    fn video_with_uploader(id: &str, title: &str, uploader: &str) -> VideoSummary {
        VideoSummary {
            uploader_name: Some(uploader.to_string()),
            ..video(id, title)
        }
    }

    fn temp_dir(name: &str) -> PathBuf {
        let suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("iwaratv-{name}-{suffix}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }
}
