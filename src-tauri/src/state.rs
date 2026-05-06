use std::sync::Arc;

use tauri::{AppHandle, Manager};

use crate::auth::AuthStore;
use crate::downloads::DownloadManager;
use crate::error::AppResult;
use crate::favorites::FavoriteStore;
use crate::iwara_client::IwaraClient;
use crate::player::PlayerService;
use crate::session::IwaraSessionService;
use crate::settings::SettingsStore;

pub struct AppState {
    pub iwara_client: Arc<IwaraClient>,
    pub player: PlayerService,
    pub session: Arc<IwaraSessionService>,
    pub settings: Arc<SettingsStore>,
    pub downloads: Arc<DownloadManager>,
    pub favorites: Arc<FavoriteStore>,
}

impl AppState {
    pub fn new(app: AppHandle) -> AppResult<Self> {
        let user_data_path = app.path().app_data_dir()?;
        let settings = Arc::new(SettingsStore::new(user_data_path.clone()));
        let downloads = Arc::new(DownloadManager::new(&user_data_path));
        let favorites = Arc::new(FavoriteStore::new(&user_data_path));
        let auth = Arc::new(AuthStore::new());
        let session = Arc::new(IwaraSessionService::new(app.clone()));
        let iwara_client = Arc::new(IwaraClient::new(
            Arc::clone(&auth),
            Arc::clone(&session),
            Arc::clone(&settings),
        ));
        Ok(Self {
            iwara_client,
            player: PlayerService::new(app),
            session,
            settings,
            downloads,
            favorites,
        })
    }
}
