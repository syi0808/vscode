mod bridge;
mod vscode_file_protocol;

use bridge::{
    resolve_window_configuration, set_webview_zoom, vscode_ipc_invoke, vscode_ipc_send, AppState,
};

use std::path::{Path, PathBuf};

use tauri::{WebviewUrl, WebviewWindowBuilder};

use url::Url;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect(
            "src-tauri must live \
         inside the vscode repository",
        )
        .to_path_buf()
}

fn workbench_url(root: &Path) -> Url {
    let file = root.join(
        "out/vs/code/electron-browser/\
         workbench/workbench-dev.html",
    );

    let normalized = file.to_string_lossy().replace('\\', "/");

    let path = if normalized.starts_with('/') {
        normalized
    } else {
        format!("/{normalized}")
    };

    let mut url = Url::parse("vscode-file://vscode-app/").expect("valid vscode-file URL");

    url.set_path(&path);

    url
}

fn main() {
    let root = repo_root()
        .canonicalize()
        .expect("failed to canonicalize repo root");

    let protocol_root = root.clone();

    let config_path = root.join(
        "src-tauri/fixtures/\
             window-config.json",
    );

    tauri::Builder::default()
        .manage(AppState {
            root: root.clone(),
            config_path,
        })
        .register_uri_scheme_protocol("vscode-file", move |_context, request| {
            vscode_file_protocol::handle(&protocol_root, request)
        })
        .invoke_handler(tauri::generate_handler![
            resolve_window_configuration,
            vscode_ipc_invoke,
            vscode_ipc_send,
            set_webview_zoom,
        ])
        .setup(move |app| {
            let url = workbench_url(&root);

            WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url))
                .initialization_script(include_str!("../preload/vscode.js"))
                .title("Code Tauri")
                .inner_size(1440.0, 900.0)
                .resizable(true)
                .devtools(true)
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Code Tauri");
}
