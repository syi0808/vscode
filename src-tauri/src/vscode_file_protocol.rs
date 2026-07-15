use http::{
    header::{CACHE_CONTROL, CONTENT_TYPE},
    Request, Response, StatusCode,
};
use percent_encoding::percent_decode_str;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn response(status: StatusCode, body: impl Into<Vec<u8>>) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(CACHE_CONTROL, "no-store")
        .body(body.into())
        .expect("failed to build protocol response")
}

fn request_path(uri_path: &str) -> PathBuf {
    let decoded = percent_decode_str(uri_path)
        .decode_utf8_lossy()
        .into_owned();

    // Tauri custom protocol URLs on Windows can produce:
    //
    // /C:/Users/...
    //
    // std::fs expects:
    //
    // C:/Users/...
    #[cfg(target_os = "windows")]
    {
        let bytes = decoded.as_bytes();

        if bytes.len() >= 3 && bytes[0] == b'/' && bytes[2] == b':' {
            return PathBuf::from(&decoded[1..]);
        }
    }

    PathBuf::from(decoded)
}

pub fn handle(root: &Path, request: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let requested = request_path(request.uri().path());

    let requested = match requested.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            eprintln!("[vscode-file] 404 {}", request.uri());

            return response(StatusCode::NOT_FOUND, b"not found".to_vec());
        }
    };

    // Do not allow arbitrary filesystem access through the asset protocol.
    if !requested.starts_with(root) {
        eprintln!("[vscode-file] forbidden: {}", requested.display());

        return response(StatusCode::FORBIDDEN, b"forbidden".to_vec());
    }

    let bytes = match fs::read(&requested) {
        Ok(bytes) => bytes,
        Err(error) => {
            eprintln!(
                "[vscode-file] failed to read {}: {error}",
                requested.display()
            );

            return response(StatusCode::NOT_FOUND, b"not found".to_vec());
        }
    };

    let mime = mime_guess::from_path(&requested)
        .first_or_octet_stream()
        .essence_str()
        .to_owned();

    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime)
        .header(CACHE_CONTROL, "no-store")
        .body(bytes)
        .expect("failed to build protocol response")
}
