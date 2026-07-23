use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{
    AppHandle,
    Manager,
    State,
    WebviewWindow,
};

pub struct AppState {
    pub root: PathBuf,
    pub config_path: PathBuf,
    user_data_dir: PathBuf,
    logs_dir: PathBuf,
    extensions_dir: PathBuf,
    home_dir: PathBuf,
}

impl AppState {
    pub fn new(
        app: &AppHandle,
        root: PathBuf,
        config_path: PathBuf,
    ) -> Result<Self, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let user_data_dir = data_dir.join("userdata");
        let logs_dir = data_dir.join("logs");
        let extensions_dir = data_dir.join("extensions");
        let home_dir = app
            .path()
            .home_dir()
            .map_err(|error| error.to_string())?;

        for path in [
            &user_data_dir,
            &user_data_dir.join("User"),
            &user_data_dir.join("User/profiles"),
            &user_data_dir.join("Backups"),
            &user_data_dir.join("CachedProfilesData"),
            &logs_dir,
            &extensions_dir,
        ] {
            fs::create_dir_all(path)
                .map_err(|error| format!("failed to create {}: {error}", path.display()))?;
        }

        Ok(Self {
            root,
            config_path,
            user_data_dir,
            logs_dir,
            extensions_dir,
            home_dir,
        })
    }
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

    rewrite_fixture_paths(&mut config, state);

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

fn rewrite_fixture_paths(
    config: &mut Value,
    state: &AppState,
) {
    let old_root =
        config["appRoot"].as_str().map(str::to_owned);
    let old_user_data =
        config["userDataDir"].as_str().map(str::to_owned);
    let old_home =
        config["homeDir"].as_str().map(str::to_owned);
    let old_extensions =
        old_home.as_deref().map(|home| {
            Path::new(home)
                .join(".vscode-oss-dev/extensions")
                .to_string_lossy()
                .into_owned()
        });
    let replacements = [
        old_root.map(|path| (
            path,
            state.root.to_string_lossy().into_owned(),
        )),
        old_user_data.map(|path| (
            path,
            state.user_data_dir.to_string_lossy().into_owned(),
        )),
        old_extensions.map(|path| (
            path,
            state.extensions_dir.to_string_lossy().into_owned(),
        )),
        old_home.map(|path| (
            path,
            state.home_dir.to_string_lossy().into_owned(),
        )),
    ];

    rewrite_strings(config, &replacements);
    config["homeDir"] =
        json!(state.home_dir.to_string_lossy().to_string());
    config["tmpDir"] =
        json!(std::env::temp_dir().to_string_lossy().to_string());
    config["userDataDir"] =
        json!(state.user_data_dir.to_string_lossy().to_string());
    config["logsPath"] =
        json!(state.logs_dir.to_string_lossy().to_string());
}

fn rewrite_strings(
    value: &mut Value,
    replacements: &[Option<(String, String)>],
) {
    match value {
        Value::String(value) => {
            for (from, to) in replacements.iter().flatten() {
                if value.contains(from) {
                    *value = value.replace(from, to);
                }
            }
        }
        Value::Array(values) => {
            for value in values {
                rewrite_strings(value, replacements);
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                rewrite_strings(value, replacements);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rewrites_fixture_paths_for_current_runtime() {
        let state = AppState {
            root: PathBuf::from("/current/vscode"),
            config_path: PathBuf::from("window-config.json"),
            user_data_dir: PathBuf::from("/current/data/userdata"),
            logs_dir: PathBuf::from("/current/data/logs"),
            extensions_dir: PathBuf::from("/current/data/extensions"),
            home_dir: PathBuf::from("/current/home"),
        };
        let mut config = json!({
            "appRoot": "/fixture/vscode",
            "homeDir": "/fixture/home",
            "tmpDir": "/fixture/tmp",
            "userDataDir": "/fixture/data",
            "logsPath": "/fixture/data/logs/old",
            "workspace": {
                "uri": {
                    "path": "/fixture/vscode",
                    "_fsPath": "/fixture/vscode"
                }
            },
            "profiles": {
                "profile": {
                    "location": {
                        "path": "/fixture/data/User/profiles"
                    },
                    "extensionsResource": {
                        "path": "/fixture/home/.vscode-oss-dev/extensions"
                    }
                }
            }
        });

        rewrite_fixture_paths(&mut config, &state);

        assert_eq!(config["appRoot"], "/current/vscode");
        assert_eq!(config["workspace"]["uri"]["path"], "/current/vscode");
        assert_eq!(config["userDataDir"], "/current/data/userdata");
        assert_eq!(
            config["profiles"]["profile"]["location"]["path"],
            "/current/data/userdata/User/profiles"
        );
        assert_eq!(
            config["profiles"]["profile"]["extensionsResource"]["path"],
            "/current/data/extensions"
        );
        assert_eq!(config["logsPath"], "/current/data/logs");
        assert_eq!(config["homeDir"], "/current/home");
    }
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
