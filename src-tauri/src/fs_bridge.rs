use percent_encoding::percent_decode_str;
use serde::Serialize;
use std::{
    fs,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use tauri::ipc::{InvokeBody, Request, Response};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsStat {
    entry_type: String,
    size: u64,
    mtime: u64,
    ctime: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    name: String,
    entry_type: String,
}

fn millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn entry_type(metadata: &fs::Metadata) -> String {
    if metadata.is_dir() {
        "directory".into()
    } else if metadata.file_type().is_symlink() {
        "symlink".into()
    } else {
        "file".into()
    }
}

#[tauri::command]
pub fn fs_stat(path: String) -> Result<FsStat, String> {
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;

    let mtime = metadata.modified().map(millis).unwrap_or_default();

    let ctime = metadata.created().map(millis).unwrap_or(mtime);

    Ok(FsStat {
        entry_type: entry_type(&metadata),

        size: metadata.len(),

        mtime,
        ctime,
    })
}

#[tauri::command]
pub fn fs_readdir(path: String) -> Result<Vec<FsEntry>, String> {
    let entries = fs::read_dir(&path).map_err(|error| error.to_string())?;

    let mut result = Vec::new();

    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;

        let metadata = entry.file_type().map_err(|error| error.to_string())?;

        let kind = if metadata.is_dir() {
            "directory"
        } else if metadata.is_symlink() {
            "symlink"
        } else {
            "file"
        };

        result.push(FsEntry {
            name: entry.file_name().to_string_lossy().to_string(),

            entry_type: kind.into(),
        });
    }

    Ok(result)
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<Response, String> {
    let bytes = fs::read(path).map_err(|error| error.to_string())?;

    Ok(Response::new(bytes))
}

fn header(request: &Request, name: &str) -> Result<String, String> {
    request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing header: {name}"))?
        .to_str()
        .map(str::to_owned)
        .map_err(|error| error.to_string())
}

fn decode_path(encoded: &str) -> String {
    percent_decode_str(encoded).decode_utf8_lossy().into_owned()
}

#[tauri::command]
pub fn fs_write_file(request: Request) -> Result<(), String> {
    let path = decode_path(&header(&request, "x-code-tauri-path")?);

    let create = header(&request, "x-code-tauri-create")? == "true";

    let overwrite = header(&request, "x-code-tauri-overwrite")? == "true";

    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("fs_write_file expects raw body".into());
    };

    let path = Path::new(&path);

    if path.exists() && !overwrite {
        return Err(format!("file already exists: {}", path.display()));
    }

    if !path.exists() && !create {
        return Err(format!("file does not exist: {}", path.display()));
    }

    fs::write(path, bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn fs_mkdir(path: String) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn fs_delete(path: String, recursive: bool) -> Result<(), String> {
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;

    if metadata.is_dir() {
        if recursive {
            fs::remove_dir_all(path)
        } else {
            fs::remove_dir(path)
        }
    } else {
        fs::remove_file(path)
    }
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn fs_rename(from_path: String, to_path: String, overwrite: bool) -> Result<(), String> {
    let target = Path::new(&to_path);

    if target.exists() {
        if !overwrite {
            return Err(format!("target exists: {}", target.display()));
        }

        let metadata = fs::symlink_metadata(target).map_err(|error| error.to_string())?;

        if metadata.is_dir() {
            fs::remove_dir_all(target)
        } else {
            fs::remove_file(target)
        }
        .map_err(|error| error.to_string())?;
    }

    fs::rename(from_path, to_path).map_err(|error| error.to_string())
}
