use serde::Serialize;
use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::State;

use crate::bridge::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedLocalExtension {
    location: String,
    manifest: Value,
}

#[tauri::command]
pub fn scan_local_extensions(
    state: State<'_, AppState>,
) -> Result<Vec<ScannedLocalExtension>, String> {
    let root = state.root.join(".code-tauri/extensions");

    if !root.exists() {
        return Ok(Vec::new());
    }

    let entries = fs::read_dir(&root)
        .map_err(|error| format!("failed to read {}: {error}", root.display()))?;

    let mut extensions = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let location = entry.path();

        if !location.is_dir() {
            continue;
        }

        let manifest_path: PathBuf = location.join("package.json");
        if !manifest_path.is_file() {
            continue;
        }

        let source = fs::read_to_string(&manifest_path)
            .map_err(|error| format!("failed to read {}: {error}", manifest_path.display()))?;
        let manifest: Value = serde_json::from_str(&source)
            .map_err(|error| format!("invalid {}: {error}", manifest_path.display()))?;

        for field in ["name", "publisher", "version", "engines"] {
            if manifest.get(field).is_none() {
                return Err(format!(
                    "extension manifest {} is missing `{field}`",
                    manifest_path.display()
                ));
            }
        }

        extensions.push(ScannedLocalExtension {
            location: location.to_string_lossy().into_owned(),
            manifest,
        });
    }

    extensions.sort_by(|left, right| left.location.cmp(&right.location));
    eprintln!(
        "[code-tauri] scanned {} local extension(s) from {}",
        extensions.len(),
        root.display()
    );

    Ok(extensions)
}
