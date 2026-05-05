use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;

use crate::error::{message, AppResult};
use crate::iwara_client::now_iso_string;
use crate::models::{
    DownloadDeleteRequest, DownloadResult, DownloadState, DownloadTask, DownloadTaskStatus,
    DownloadVideoRequest,
};
use crate::settings::to_summary;

const MAX_HISTORY_ITEMS: usize = 200;
const MAX_SEGMENT_PARTS: u64 = 8;

pub struct DownloadStart {
    pub task: DownloadTask,
    pub is_new: bool,
}

pub struct DownloadManager {
    file_path: PathBuf,
    active: Mutex<Vec<DownloadTask>>,
    history: Mutex<Vec<DownloadTask>>,
    next_id: AtomicU64,
}

impl DownloadManager {
    pub fn new(user_data_path: &Path) -> Self {
        let file_path = user_data_path.join("downloads.json");
        let history = load_download_history(&file_path);
        Self {
            file_path,
            active: Mutex::new(Vec::new()),
            history: Mutex::new(history),
            next_id: AtomicU64::new(1),
        }
    }

    pub fn state(&self) -> DownloadState {
        DownloadState {
            active: self.active.lock().expect("download mutex poisoned").clone(),
            history: self
                .history
                .lock()
                .expect("download mutex poisoned")
                .clone(),
        }
    }

    pub fn start(&self, request: DownloadVideoRequest) -> DownloadStart {
        if let Some(task) = self.find_active_by_request(&request) {
            return DownloadStart {
                task,
                is_new: false,
            };
        }

        let now = now_iso_string();
        let task = DownloadTask {
            id: self.next_task_id(),
            video_id: request.video_id,
            requested_quality: request.quality,
            status: DownloadTaskStatus::Queued,
            video: None,
            format: None,
            path: None,
            directory: None,
            bytes_written: 0,
            total_bytes: None,
            fallback_from: None,
            error: None,
            created_at: now.clone(),
            updated_at: now,
            completed_at: None,
        };
        self.active
            .lock()
            .expect("download mutex poisoned")
            .insert(0, task.clone());
        DownloadStart { task, is_new: true }
    }

    pub fn request_for_retry(&self, id: &str) -> AppResult<DownloadVideoRequest> {
        let history = self.history.lock().expect("download mutex poisoned");
        let task = history
            .iter()
            .find(|task| task.id == id)
            .ok_or_else(|| message("没有找到可重试的下载记录。"))?;
        Ok(DownloadVideoRequest {
            video_id: task.video_id.clone(),
            quality: task
                .requested_quality
                .clone()
                .or_else(|| task.format.as_ref().map(|format| format.id.clone())),
        })
    }

    pub fn mark_downloading(
        &self,
        id: &str,
        plan: &crate::iwara_client::DownloadPlan,
    ) -> AppResult<DownloadTask> {
        let mut active = self.active.lock().expect("download mutex poisoned");
        let task = active
            .iter_mut()
            .find(|task| task.id == id)
            .ok_or_else(|| message("下载任务已经不存在。"))?;
        task.status = DownloadTaskStatus::Downloading;
        task.video = Some(to_summary(&plan.video));
        task.format = Some(plan.format.clone());
        task.path = Some(plan.path.to_string_lossy().to_string());
        task.directory = plan
            .path
            .parent()
            .map(|path| path.to_string_lossy().to_string());
        task.fallback_from = plan.fallback_from.clone();
        task.error = None;
        task.updated_at = now_iso_string();
        Ok(task.clone())
    }

    pub fn update_progress(&self, id: &str, bytes_written: u64, total_bytes: Option<u64>) {
        let mut active = self.active.lock().expect("download mutex poisoned");
        if let Some(task) = active.iter_mut().find(|task| task.id == id) {
            task.bytes_written = bytes_written;
            task.total_bytes = total_bytes.or(task.total_bytes);
            task.updated_at = now_iso_string();
        }
    }

    pub fn complete(&self, id: &str, result: DownloadResult) -> AppResult<DownloadTask> {
        let mut task = self
            .take_active(id)
            .unwrap_or_else(|| self.completed_task_from_result(id.to_string(), &result));
        let now = now_iso_string();
        task.status = DownloadTaskStatus::Completed;
        task.video_id = result.video.summary.id.clone();
        task.video = Some(to_summary(&result.video));
        task.format = Some(result.format);
        task.path = Some(result.path.clone());
        task.directory = Path::new(&result.path)
            .parent()
            .map(|path| path.to_string_lossy().to_string());
        task.bytes_written = result.bytes_written;
        task.total_bytes = Some(result.bytes_written);
        task.fallback_from = result.fallback_from;
        task.error = None;
        task.updated_at = now.clone();
        task.completed_at = Some(now);
        self.push_history(task.clone())?;
        Ok(task)
    }

    pub fn fail(&self, id: &str, error: String) -> AppResult<DownloadTask> {
        let mut task = self.take_active(id).unwrap_or_else(|| {
            let now = now_iso_string();
            DownloadTask {
                id: id.to_string(),
                video_id: String::new(),
                requested_quality: None,
                status: DownloadTaskStatus::Failed,
                video: None,
                format: None,
                path: None,
                directory: None,
                bytes_written: 0,
                total_bytes: None,
                fallback_from: None,
                error: None,
                created_at: now.clone(),
                updated_at: now,
                completed_at: None,
            }
        });
        let now = now_iso_string();
        task.status = DownloadTaskStatus::Failed;
        task.error = Some(error);
        task.updated_at = now.clone();
        task.completed_at = Some(now);
        self.push_history(task.clone())?;
        Ok(task)
    }

    pub async fn delete(&self, request: DownloadDeleteRequest) -> AppResult<DownloadState> {
        if self
            .active
            .lock()
            .expect("download mutex poisoned")
            .iter()
            .any(|task| task.id == request.id)
        {
            return Err(message("进行中的下载暂不能删除。"));
        }

        let removed = {
            let mut history = self.history.lock().expect("download mutex poisoned");
            let Some(index) = history.iter().position(|task| task.id == request.id) else {
                return Ok(self.state());
            };
            Some(history.remove(index))
        };

        if let Some(task) = removed {
            if request.delete_file {
                if let Some(path) = task.path {
                    remove_download_artifacts(Path::new(&path)).await?;
                }
            }
            self.save()?;
        }

        Ok(self.state())
    }

    pub fn task(&self, id: &str) -> Option<DownloadTask> {
        self.active
            .lock()
            .expect("download mutex poisoned")
            .iter()
            .find(|task| task.id == id)
            .cloned()
            .or_else(|| {
                self.history
                    .lock()
                    .expect("download mutex poisoned")
                    .iter()
                    .find(|task| task.id == id)
                    .cloned()
            })
    }

    fn find_active_by_request(&self, request: &DownloadVideoRequest) -> Option<DownloadTask> {
        self.active
            .lock()
            .expect("download mutex poisoned")
            .iter()
            .find(|task| {
                task.video_id == request.video_id && task.requested_quality == request.quality
            })
            .cloned()
    }

    fn take_active(&self, id: &str) -> Option<DownloadTask> {
        let mut active = self.active.lock().expect("download mutex poisoned");
        let index = active.iter().position(|task| task.id == id)?;
        Some(active.remove(index))
    }

    fn completed_task_from_result(&self, id: String, result: &DownloadResult) -> DownloadTask {
        let now = now_iso_string();
        DownloadTask {
            id,
            video_id: result.video.summary.id.clone(),
            requested_quality: result
                .fallback_from
                .clone()
                .or_else(|| Some(result.format.id.clone())),
            status: DownloadTaskStatus::Completed,
            video: Some(to_summary(&result.video)),
            format: Some(result.format.clone()),
            path: Some(result.path.clone()),
            directory: Path::new(&result.path)
                .parent()
                .map(|path| path.to_string_lossy().to_string()),
            bytes_written: result.bytes_written,
            total_bytes: Some(result.bytes_written),
            fallback_from: result.fallback_from.clone(),
            error: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            completed_at: Some(now),
        }
    }

    fn push_history(&self, task: DownloadTask) -> AppResult<()> {
        {
            let mut history = self.history.lock().expect("download mutex poisoned");
            history.retain(|item| item.id != task.id);
            history.insert(0, task);
            history.truncate(MAX_HISTORY_ITEMS);
        }
        self.save()
    }

    fn save(&self) -> AppResult<()> {
        let history = self
            .history
            .lock()
            .expect("download mutex poisoned")
            .clone();
        persist_download_history(&self.file_path, &history)
    }

    fn next_task_id(&self) -> String {
        let counter = self.next_id.fetch_add(1, Ordering::Relaxed);
        let timestamp = time::OffsetDateTime::now_utc().unix_timestamp();
        format!("download-{timestamp}-{counter}")
    }
}

fn load_download_history(path: &Path) -> Vec<DownloadTask> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<DownloadState>(&raw).ok())
        .map(|state| state.history)
        .unwrap_or_default()
}

fn persist_download_history(path: &Path, history: &[DownloadTask]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let state = DownloadState {
        active: Vec::new(),
        history: history.to_vec(),
    };
    fs::write(path, format!("{}\n", serde_json::to_string_pretty(&state)?))?;
    Ok(())
}

async fn remove_download_artifacts(path: &Path) -> AppResult<()> {
    remove_file_if_exists(path).await?;
    remove_file_if_exists(&partial_download_path(path)).await?;
    for index in 0..MAX_SEGMENT_PARTS {
        remove_file_if_exists(&segment_part_path(path, index)).await?;
    }
    Ok(())
}

async fn remove_file_if_exists(path: &Path) -> AppResult<()> {
    match tokio::fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err.into()),
    }
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
