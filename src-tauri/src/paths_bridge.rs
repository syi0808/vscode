use serde::Serialize;

use std::{
    fs,
    path::PathBuf,
};

use tauri::{
    AppHandle,
    Manager,
};


#[derive(
    Serialize,
)]
#[serde(
    rename_all = "camelCase"
)]
pub struct AppPaths {
    data_dir: String,
    cache_dir: String,
    user_data_dir: String,
    logs_dir: String,
    extensions_dir: String,
}


fn as_string(
    path: PathBuf,
) -> String {
    path
        .to_string_lossy()
        .to_string()
}


#[tauri::command]
pub fn get_app_paths(
    app: AppHandle,
) -> Result<AppPaths, String> {

    let data_dir =
        app
            .path()
            .app_data_dir()
            .map_err(
                |error|
                    error.to_string()
            )?;

    let cache_dir =
        app
            .path()
            .app_cache_dir()
            .map_err(
                |error|
                    error.to_string()
            )?;

    let user_data_dir =
        data_dir.join(
            "userdata",
        );

    let logs_dir =
        data_dir.join(
            "logs",
        );

    let extensions_dir =
        data_dir.join(
            "extensions",
        );


    for path in [
        &data_dir,
        &cache_dir,
        &user_data_dir,
        &logs_dir,
        &extensions_dir,
    ] {
        fs::create_dir_all(
            path,
        )
        .map_err(
            |error|
                error.to_string()
        )?;
    }


    Ok(
        AppPaths {
            data_dir:
                as_string(
                    data_dir
                ),

            cache_dir:
                as_string(
                    cache_dir
                ),

            user_data_dir:
                as_string(
                    user_data_dir
                ),

            logs_dir:
                as_string(
                    logs_dir
                ),

            extensions_dir:
                as_string(
                    extensions_dir
                ),
        },
    )
}
