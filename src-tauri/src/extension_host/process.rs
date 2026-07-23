use crate::extension_host::resource::{ExtensionHostExit, ExtensionHostRegistry};
use std::{path::PathBuf, process::Stdio, sync::Arc};
use tauri::{AppHandle, Emitter};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::{ChildStderr, ChildStdout, Command},
    time::{sleep, Duration},
};

fn repo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "src-tauri must be inside the VS Code repository".to_owned())
}

fn bundled_bun_path() -> Option<PathBuf> {
    let executable_name = if cfg!(windows) {
        "vscode-bun.exe"
    } else {
        "vscode-bun"
    };
    if let Ok(current_executable) = std::env::current_exe() {
        if let Some(directory) = current_executable.parent() {
            let bundled = directory.join(executable_name);
            if bundled.is_file() {
                return Some(bundled);
            }
        }
    }

    let target_name = if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("vscode-bun-aarch64-apple-darwin")
    } else {
        None
    };
    target_name
        .map(|name| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(name)
        })
        .filter(|path| path.is_file())
}

fn bun_path() -> PathBuf {
    std::env::var_os("CODE_TAURI_BUN")
        .map(PathBuf::from)
        .or_else(bundled_bun_path)
        .unwrap_or_else(|| PathBuf::from("bun"))
}

pub fn spawn(
    environment: &std::collections::HashMap<String, Option<String>>,
    exec_argv: &[String],
    session: &nwipc::Session,
) -> Result<tokio::process::Child, String> {
    let root = repo_root()?;
    let bootstrap = root.join("out/bootstrap-fork.js");
    if !bootstrap.exists() {
        return Err(format!(
            "missing {}. Start the VS Code build task first",
            bootstrap.display()
        ));
    }

    let mut command = Command::new(bun_path());
    command
        .current_dir(root)
        .args(exec_argv)
        .arg(bootstrap)
        .arg("--skipWorkspaceStorageLock")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(false);

    for (key, value) in environment {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }
    session.peer_environment().apply(command.as_std_mut());
    command.env("VSCODE_PARENT_PID", std::process::id().to_string());
    command
        .spawn()
        .map_err(|error| format!("failed to spawn Bun extension host: {error}"))
}

pub fn forward_stdout(app: AppHandle, id: String, stdout: ChildStdout) {
    tokio::spawn(forward_output(
        app,
        id,
        stdout,
        "vscode://extension-host/stdout",
    ));
}

pub fn forward_stderr(app: AppHandle, id: String, stderr: ChildStderr) {
    tokio::spawn(forward_output(
        app,
        id,
        stderr,
        "vscode://extension-host/stderr",
    ));
}

async fn forward_output<R: AsyncRead + Unpin>(
    app: AppHandle,
    id: String,
    mut reader: R,
    event: &'static str,
) {
    let mut buffer = vec![0_u8; 16 * 1024];
    loop {
        let size = match reader.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(size) => size,
        };
        let _ = app.emit(
            event,
            serde_json::json!({
                "id": id,
                "data": String::from_utf8_lossy(&buffer[..size]),
            }),
        );
    }
}

pub fn watch_exit(app: AppHandle, registry: Arc<ExtensionHostRegistry>, id: String) {
    tokio::spawn(async move {
        loop {
            let resource = match registry.get(&id).await {
                Ok(resource) => resource,
                Err(_) => return,
            };
            let status = {
                let mut resource = resource.lock().await;
                match resource.child.as_mut() {
                    Some(child) => child.try_wait(),
                    None => return,
                }
            };

            match status {
                Ok(Some(status)) => {
                    #[cfg(unix)]
                    let signal = {
                        use std::os::unix::process::ExitStatusExt;
                        status
                            .signal()
                            .map(|value| value.to_string())
                            .unwrap_or_default()
                    };
                    #[cfg(not(unix))]
                    let signal = String::new();
                    finish_exit(
                        &app,
                        &registry,
                        &id,
                        status.code().unwrap_or_default(),
                        signal,
                    )
                    .await;
                    return;
                }
                Ok(None) => sleep(Duration::from_millis(50)).await,
                Err(error) => {
                    finish_exit(&app, &registry, &id, 0, error.to_string()).await;
                    return;
                }
            }
        }
    });
}

async fn finish_exit(
    app: &AppHandle,
    registry: &ExtensionHostRegistry,
    id: &str,
    code: i32,
    signal: String,
) {
    let Ok(resource) = registry.get(id).await else {
        return;
    };
    let (exit_state, socket_path) = {
        let resource = resource.lock().await;
        (Arc::clone(&resource.exit), resource.socket_path.clone())
    };
    let exit = ExtensionHostExit {
        id: id.to_owned(),
        code,
        signal,
    };
    let should_emit = exit_state.set(exit.clone()).await;
    {
        let mut resource = resource.lock().await;
        resource.writer.take();
        resource.child.take();
    }
    super::transport::cleanup_socket(&socket_path).await;
    if should_emit {
        let _ = app.emit("vscode://extension-host/exit", exit);
    }
}
