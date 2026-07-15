use globset::{Glob, GlobSet, GlobSetBuilder};

use notify::{event::ModifyKind, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};

use serde::Serialize;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

use tauri::{ipc::Channel, State};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsWatchChange {
    kind: String,
    path: String,
}

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum FsWatchMessage {
    Changes { changes: Vec<FsWatchChange> },

    Error { message: String },
}

#[derive(Default)]
pub struct FileWatchState {
    next_id: AtomicU64,

    watchers: Mutex<HashMap<u64, RecommendedWatcher>>,
}

fn build_excludes(patterns: &[String]) -> Result<GlobSet, String> {
    let mut builder = GlobSetBuilder::new();

    for pattern in patterns {
        let pattern = pattern.replace('\\', "/");

        if pattern.is_empty() {
            continue;
        }

        match Glob::new(&pattern) {
            Ok(glob) => {
                builder.add(glob);
            }

            Err(error) => {
                eprintln!(
                    "[watcher] ignoring \
                     invalid exclude \
                     {pattern}: {error}"
                );
            }
        }
    }

    builder.build().map_err(|error| error.to_string())
}

fn is_excluded(excludes: &GlobSet, root: &Path, path: &Path) -> bool {
    if excludes.is_empty() {
        return false;
    }

    if excludes.is_match(path) {
        return true;
    }

    if let Ok(relative) = path.strip_prefix(root) {
        return excludes.is_match(relative);
    }

    false
}

fn push_change(
    changes: &mut Vec<FsWatchChange>,
    kind: &str,
    path: &Path,
    root: &Path,
    excludes: &GlobSet,
) {
    if is_excluded(excludes, root, path) {
        return;
    }

    changes.push(FsWatchChange {
        kind: kind.to_owned(),

        path: path.to_string_lossy().to_string(),
    });
}

fn convert_event(event: Event, root: &Path, excludes: &GlobSet) -> Vec<FsWatchChange> {
    let mut changes = Vec::new();

    match event.kind {
        EventKind::Create(_) => {
            for path in event.paths {
                push_change(&mut changes, "added", &path, root, excludes);
            }
        }

        EventKind::Remove(_) => {
            for path in event.paths {
                push_change(&mut changes, "deleted", &path, root, excludes);
            }
        }

        EventKind::Modify(ModifyKind::Name(_)) if event.paths.len() >= 2 => {
            push_change(&mut changes, "deleted", &event.paths[0], root, excludes);

            push_change(&mut changes, "added", &event.paths[1], root, excludes);
        }

        EventKind::Modify(_) => {
            for path in event.paths {
                push_change(&mut changes, "updated", &path, root, excludes);
            }
        }

        EventKind::Access(_) | EventKind::Other | EventKind::Any => {}
    }

    changes
}

#[tauri::command]
pub fn fs_watch_start(
    path: String,
    recursive: bool,
    excludes: Vec<String>,
    on_event: Channel<FsWatchMessage>,
    state: State<'_, FileWatchState>,
) -> Result<u64, String> {
    let root = PathBuf::from(&path);

    let callback_root = root.clone();

    let excludes = build_excludes(&excludes)?;

    let mut watcher =
        notify::recommended_watcher(move |result: notify::Result<Event>| match result {
            Ok(event) => {
                let changes = convert_event(event, &callback_root, &excludes);

                if !changes.is_empty() {
                    let _ = on_event.send(FsWatchMessage::Changes { changes });
                }
            }

            Err(error) => {
                let _ = on_event.send(FsWatchMessage::Error {
                    message: error.to_string(),
                });
            }
        })
        .map_err(|error| error.to_string())?;

    let mode = if recursive {
        RecursiveMode::Recursive
    } else {
        RecursiveMode::NonRecursive
    };

    watcher
        .watch(&root, mode)
        .map_err(|error| error.to_string())?;

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;

    state
        .watchers
        .lock()
        .map_err(|_| "watcher state poisoned".to_owned())?
        .insert(id, watcher);

    Ok(id)
}

#[tauri::command]
pub fn fs_watch_stop(watch_id: u64, state: State<'_, FileWatchState>) -> Result<(), String> {
    state
        .watchers
        .lock()
        .map_err(|_| "watcher state poisoned".to_owned())?
        .remove(&watch_id);

    Ok(())
}
