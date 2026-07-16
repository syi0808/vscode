use serde_json::{json, Value};
use std::{
    fs,
    path::PathBuf,
};
use tauri::{
    State,
    WebviewWindow,
};

pub struct AppState {
    pub root: PathBuf,
    pub config_path: PathBuf,
}

fn load_config(
    state: &AppState,
) -> Result<Value, String> {
    let text = fs::read_to_string(&state.config_path)
        .map_err(|error| {
            format!(
                "failed to read {}: {error}",
                state.config_path.display()
            )
        })?;

    let mut config: Value =
        serde_json::from_str(&text)
            .map_err(|error| error.to_string())?;

    config["mainPid"] = json!(std::process::id());

    config["execPath"] = json!(
        std::env::current_exe()
            .map_err(|error| error.to_string())?
            .to_string_lossy()
            .to_string()
    );

    config["appRoot"] =
        json!(state.root.to_string_lossy().to_string());

    if !config["userEnv"].is_object() {
        config["userEnv"] = json!({});
    }

    config["userEnv"]["VSCODE_DEV"] = json!("1");
    config["userEnv"]["NODE_ENV"] = json!("development");

    Ok(config)
}

#[tauri::command]
pub fn resolve_window_configuration(
    state: State<'_, AppState>,
) -> Result<Value, String> {
    load_config(&state)
}

#[tauri::command]
pub fn code_tauri_log(message: String) {
    eprintln!("[code-tauri webview] {message}");
}

#[tauri::command]
pub fn vscode_ipc_invoke(
    channel: String,
    args: Vec<Value>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    match channel.as_str() {
        "vscode:fetchShellEnv" => {
            let config = load_config(&state)?;
            Ok(config["userEnv"].clone())
        }

        other => {
            eprintln!(
                "[tauri ipc invoke] unimplemented: \
                 {other} args={args:?}"
            );

            Ok(Value::Null)
        }
    }
}

#[tauri::command]
pub fn vscode_ipc_send(
    window: WebviewWindow,
    channel: String,
    args: Vec<Value>,
) -> Result<(), String> {
    match channel.as_str() {
        "vscode:openDevTools" => {
            window.open_devtools();
        }

        "vscode:toggleDevTools" => {
            if window.is_devtools_open() {
                window.close_devtools();
            } else {
                window.open_devtools();
            }
        }

        "vscode:reloadWindow" => {
            window
                .reload()
                .map_err(|error| error.to_string())?;
        }

        "vscode:closeWindow" => {
            window
                .close()
                .map_err(|error| error.to_string())?;
        }

        other => {
            eprintln!(
                "[tauri ipc send] unimplemented: \
                 {other} args={args:?}"
            );
        }
    }

    Ok(())
}

#[tauri::command]
pub fn set_webview_zoom(
    window: WebviewWindow,
    level: f64,
) -> Result<(), String> {
    // Electron/VS Code zoom-level convention:
    // factor = 1.2 ^ level
    let factor = 1.2_f64.powf(level);

    window
        .set_zoom(factor)
        .map_err(|error| error.to_string())
}
