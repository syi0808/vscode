use super::{
    process,
    resource::{ExitState, ExtensionHostRegistry},
    transport,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, sync::Arc};
use tauri::{AppHandle, State};
use tokio::{
    io::AsyncWriteExt,
    net::UnixListener,
    time::{timeout, Duration},
};
use uuid::Uuid;

#[derive(Serialize)]
pub struct CreateResult {
    id: String,
}

#[derive(Serialize)]
pub struct StartResult {
    pid: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHostProcessOptions {
    env: HashMap<String, Option<String>>,
    #[serde(default)]
    exec_argv: Vec<String>,
}

fn socket_path(id: &str) -> PathBuf {
    PathBuf::from("/tmp/vscode-tauri").join(format!("ext-host-{id}.sock"))
}

#[tauri::command]
pub async fn ext_host_create(
    registry: State<'_, Arc<ExtensionHostRegistry>>,
) -> Result<CreateResult, String> {
    let id = Uuid::new_v4().simple().to_string()[..16].to_owned();
    let path = socket_path(&id);
    tokio::fs::create_dir_all(path.parent().expect("socket path has parent"))
        .await
        .map_err(|error| error.to_string())?;
    transport::cleanup_socket(&path).await;
    registry.create(id.clone(), path).await;
    Ok(CreateResult { id })
}

#[tauri::command]
pub async fn ext_host_start(
    app: AppHandle,
    registry: State<'_, Arc<ExtensionHostRegistry>>,
    id: String,
    options: ExtensionHostProcessOptions,
) -> Result<StartResult, String> {
    let resource = registry.get(&id).await?;
    let expected_path = {
        let resource = resource.lock().await;
        if resource.id != id {
            return Err("Extension Host resource ID does not match".to_owned());
        }
        resource.socket_path.clone()
    };
    let hook = options
        .env
        .get("VSCODE_EXTHOST_IPC_HOOK")
        .and_then(|value| value.as_ref())
        .ok_or_else(|| "VSCODE_EXTHOST_IPC_HOOK is missing".to_owned())?;
    if PathBuf::from(hook) != expected_path {
        return Err("Extension Host IPC hook does not match its resource".to_owned());
    }

    transport::cleanup_socket(&expected_path).await;
    let listener = UnixListener::bind(&expected_path)
        .map_err(|error| format!("failed to bind {}: {error}", expected_path.display()))?;
    let mut child = match process::spawn(&options.env, &options.exec_argv) {
        Ok(child) => child,
        Err(error) => {
            transport::cleanup_socket(&expected_path).await;
            return Err(error);
        }
    };
    let pid = child.id();
    if let Some(stdout) = child.stdout.take() {
        process::forward_stdout(app.clone(), id.clone(), stdout);
    }
    if let Some(stderr) = child.stderr.take() {
        process::forward_stderr(app.clone(), id.clone(), stderr);
    }
    {
        let mut resource = resource.lock().await;
        if resource.child.is_some() {
            let _ = child.start_kill();
            return Err("Extension Host process has already started".to_owned());
        }
        resource.child = Some(child);
    }

    transport::accept(
        app.clone(),
        Arc::clone(registry.inner()),
        id.clone(),
        listener,
    );
    process::watch_exit(app, Arc::clone(registry.inner()), id);
    Ok(StartResult { pid })
}

#[tauri::command]
pub async fn ext_host_send(
    registry: State<'_, Arc<ExtensionHostRegistry>>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let resource = registry.get(&id).await?;
    let mut resource = resource.lock().await;
    let writer = resource
        .writer
        .as_mut()
        .ok_or_else(|| "Extension Host is not connected".to_owned())?;
    writer
        .write_all(&data)
        .await
        .map_err(|error| error.to_string())
}

async fn wait_for_exit(exit: Arc<ExitState>) {
    loop {
        let notified = exit.notify.notified();
        if exit.result().await.is_some() {
            return;
        }
        notified.await;
    }
}

#[tauri::command]
pub async fn ext_host_wait_for_exit(
    registry: State<'_, Arc<ExtensionHostRegistry>>,
    id: String,
    max_wait_time_ms: u64,
) -> Result<(), String> {
    let resource = registry.get(&id).await?;
    let exit = Arc::clone(&resource.lock().await.exit);
    if timeout(
        Duration::from_millis(max_wait_time_ms),
        wait_for_exit(Arc::clone(&exit)),
    )
    .await
    .is_err()
    {
        kill_resource(&resource).await;
        let _ = timeout(Duration::from_secs(5), wait_for_exit(Arc::clone(&exit))).await;
    }
    if exit.result().await.is_some() {
        registry.remove(&id).await;
    }
    Ok(())
}

async fn kill_resource(resource: &tokio::sync::Mutex<super::resource::ExtensionHostResource>) {
    let mut resource = resource.lock().await;
    if let Some(child) = resource.child.as_mut() {
        let _ = child.start_kill();
    } else {
        transport::cleanup_socket(&resource.socket_path).await;
    }
}

#[tauri::command]
pub async fn ext_host_kill(
    registry: State<'_, Arc<ExtensionHostRegistry>>,
    id: String,
) -> Result<(), String> {
    let resource = registry.get(&id).await?;
    kill_resource(&resource).await;
    Ok(())
}
