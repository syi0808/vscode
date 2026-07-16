use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tokio::{
    net::unix::OwnedWriteHalf,
    process::Child,
    sync::{Mutex, Notify},
};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHostExit {
    pub id: String,
    pub code: i32,
    pub signal: String,
}

#[derive(Default)]
pub struct ExitState {
    result: Mutex<Option<ExtensionHostExit>>,
    pub notify: Notify,
}

impl ExitState {
    pub async fn result(&self) -> Option<ExtensionHostExit> {
        self.result.lock().await.clone()
    }

    pub async fn set(&self, result: ExtensionHostExit) -> bool {
        let mut current = self.result.lock().await;
        if current.is_some() {
            return false;
        }
        *current = Some(result);
        drop(current);
        self.notify.notify_waiters();
        true
    }
}

pub struct ExtensionHostResource {
    pub id: String,
    pub socket_path: PathBuf,
    pub child: Option<Child>,
    pub writer: Option<OwnedWriteHalf>,
    pub exit: Arc<ExitState>,
}

#[derive(Default)]
pub struct ExtensionHostRegistry {
    resources: Mutex<HashMap<String, Arc<Mutex<ExtensionHostResource>>>>,
}

impl ExtensionHostRegistry {
    pub async fn create(&self, id: String, socket_path: PathBuf) {
        self.resources.lock().await.insert(
            id.clone(),
            Arc::new(Mutex::new(ExtensionHostResource {
                id,
                socket_path,
                child: None,
                writer: None,
                exit: Arc::new(ExitState::default()),
            })),
        );
    }

    pub async fn get(&self, id: &str) -> Result<Arc<Mutex<ExtensionHostResource>>, String> {
        self.resources
            .lock()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Unknown extension host resource: {id}"))
    }

    pub async fn remove(&self, id: &str) {
        self.resources.lock().await.remove(id);
    }

    pub async fn kill_all(&self) {
        let resources = self
            .resources
            .lock()
            .await
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for resource in resources {
            let mut resource = resource.lock().await;
            if let Some(child) = resource.child.as_mut() {
                let _ = child.start_kill();
            }
            let socket_path = resource.socket_path.clone();
            drop(resource);
            super::transport::cleanup_socket(&socket_path).await;
        }
    }
}
