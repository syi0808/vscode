use crate::extension_host::resource::ExtensionHostRegistry;
use serde::Serialize;
use std::{io::ErrorKind, path::Path, sync::Arc};
use tauri::{AppHandle, Emitter};
use tokio::{io::AsyncReadExt, net::UnixListener};

#[derive(Clone, Serialize)]
struct ConnectedEvent {
    id: String,
}

#[derive(Clone, Serialize)]
struct MessageEvent {
    id: String,
    data: Vec<u8>,
}

pub async fn cleanup_socket(path: &Path) {
    match tokio::fs::remove_file(path).await {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => eprintln!("[code-tauri] failed to remove {}: {error}", path.display()),
    }
}

pub fn accept(
    app: AppHandle,
    registry: Arc<ExtensionHostRegistry>,
    id: String,
    listener: UnixListener,
) {
    tokio::spawn(async move {
        let Ok((socket, _)) = listener.accept().await else {
            return;
        };
        let (mut reader, writer) = socket.into_split();
        let Ok(resource) = registry.get(&id).await else {
            return;
        };
        {
            let mut resource = resource.lock().await;
            if resource.exit.result().await.is_some() {
                return;
            }
            resource.writer = Some(writer);
        }
        let _ = app.emit(
            "vscode://extension-host/connected",
            ConnectedEvent { id: id.clone() },
        );

        let mut buffer = vec![0_u8; 64 * 1024];
        loop {
            let size = match reader.read(&mut buffer).await {
                Ok(0) | Err(_) => return,
                Ok(size) => size,
            };
            let _ = app.emit(
                "vscode://extension-host/message",
                MessageEvent {
                    id: id.clone(),
                    data: buffer[..size].to_vec(),
                },
            );
        }
    });
}
