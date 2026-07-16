use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
};
use tauri::{ipc::Channel, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream, UnixListener, UnixStream},
    process::{ChildStderr, ChildStdout, Command},
    sync::{mpsc, Mutex},
    time::{timeout, Duration},
};
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};
use uuid::Uuid;

const CONNECTION_TIMEOUT: Duration = Duration::from_secs(30);
const RELAY_BUFFER_SIZE: usize = 64 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHostStartResult {
    id: u64,
    pid: u32,
    websocket_url: String,
    token: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionHostExit {
    code: Option<i32>,
    signal: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExtensionHostStatus {
    Listening,
    ExtensionHostConnected,
    WebviewConnected,
    Bridging,
    Closed,
    Error { message: String },
}

#[derive(Clone)]
struct ExtensionHostControl {
    stop: mpsc::Sender<()>,
}

#[derive(Default)]
pub struct ExtensionHostState {
    next_id: AtomicU64,
    hosts: Mutex<HashMap<u64, ExtensionHostControl>>,
}

fn repo_root() -> Result<PathBuf, String> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .ok_or_else(|| "src-tauri must be inside the VS Code repository".to_owned())
}

async fn forward_stdout(stdout: ChildStdout, channel: Channel<String>) {
    forward_lines(stdout, channel, "stdout").await;
}

async fn forward_stderr(stderr: ChildStderr, channel: Channel<String>) {
    forward_lines(stderr, channel, "stderr").await;
}

async fn forward_lines<R>(reader: R, channel: Channel<String>, stream: &str)
where
    R: AsyncRead + Unpin,
{
    let mut lines = BufReader::new(reader).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        eprintln!("[Bun Extension Host {stream}] {line}");
        if channel.send(line).is_err() {
            break;
        }
    }
}

async fn accept_extension_host(
    listener: UnixListener,
    status: Channel<ExtensionHostStatus>,
) -> Result<UnixStream, String> {
    let (stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
    eprintln!("[code-tauri] Bun Extension Host connected to Unix socket");
    status
        .send(ExtensionHostStatus::ExtensionHostConnected)
        .map_err(|error| error.to_string())?;
    Ok(stream)
}

async fn accept_webview(
    listener: TcpListener,
    token: String,
    status: Channel<ExtensionHostStatus>,
) -> Result<WebSocketStream<TcpStream>, String> {
    let (stream, _) = listener.accept().await.map_err(|error| error.to_string())?;
    eprintln!("[code-tauri] Workbench connected to Extension Host WebSocket");
    stream
        .set_nodelay(true)
        .map_err(|error| error.to_string())?;

    let mut socket = accept_async(stream)
        .await
        .map_err(|error| error.to_string())?;

    let authentication = socket
        .next()
        .await
        .ok_or_else(|| "WebView disconnected before authentication".to_owned())?
        .map_err(|error| error.to_string())?;

    match authentication {
        Message::Text(value) if value.as_str() == token => {
            eprintln!("[code-tauri] Workbench Extension Host WebSocket authenticated");
            status
                .send(ExtensionHostStatus::WebviewConnected)
                .map_err(|error| error.to_string())?;
            Ok(socket)
        }
        _ => Err("WebView extension host authentication failed".to_owned()),
    }
}

async fn relay_webview_to_extension<R, W>(
    mut webview: R,
    mut extension: W,
) -> Result<(), String>
where
    R: futures_util::Stream<
            Item = Result<Message, tokio_tungstenite::tungstenite::Error>,
        > + Unpin,
    W: AsyncWrite + Unpin,
{
    while let Some(message) = webview.next().await {
        match message.map_err(|error| error.to_string())? {
            Message::Binary(bytes) => {
                extension
                    .write_all(bytes.as_ref())
                    .await
                    .map_err(|error| error.to_string())?;
                extension.flush().await.map_err(|error| error.to_string())?;
            }
            Message::Close(_) => return Ok(()),
            Message::Ping(_) | Message::Pong(_) | Message::Text(_) | Message::Frame(_) => {}
        }
    }

    Ok(())
}

async fn relay_extension_to_webview<R, W>(
    mut extension: R,
    mut webview: W,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    let mut buffer = vec![0_u8; RELAY_BUFFER_SIZE];

    loop {
        let read = extension
            .read(&mut buffer)
            .await
            .map_err(|error| error.to_string())?;

        if read == 0 {
            return Ok(());
        }

        webview
            .send(Message::Binary(buffer[..read].to_vec().into()))
            .await
            .map_err(|error| error.to_string())?;
    }
}

async fn relay(
    extension: UnixStream,
    webview: WebSocketStream<TcpStream>,
) -> Result<(), String> {
    let (extension_reader, extension_writer) = extension.into_split();
    let (webview_writer, webview_reader) = webview.split();

    tokio::select! {
        result = relay_webview_to_extension(webview_reader, extension_writer) => result,
        result = relay_extension_to_webview(extension_reader, webview_writer) => result,
    }
}

async fn run_relay(
    extension_listener: UnixListener,
    webview_listener: TcpListener,
    token: String,
    status: Channel<ExtensionHostStatus>,
) -> Result<(), String> {
    let connections = timeout(CONNECTION_TIMEOUT, async {
        tokio::try_join!(
            accept_extension_host(extension_listener, status.clone()),
            accept_webview(webview_listener, token, status.clone()),
        )
    })
    .await
    .map_err(|_| "Extension host connection timed out".to_owned())??;

    status
        .send(ExtensionHostStatus::Bridging)
        .map_err(|error| error.to_string())?;
    eprintln!("[code-tauri] Extension Host byte relay started");

    relay(connections.0, connections.1).await
}

fn remove_socket(path: &Path) {
    if let Err(error) = std::fs::remove_file(path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[code-tauri] failed to remove {}: {error}", path.display());
        }
    }
}

#[tauri::command]
pub async fn extension_host_start(
    on_stdout: Channel<String>,
    on_stderr: Channel<String>,
    on_status: Channel<ExtensionHostStatus>,
    on_exit: Channel<ExtensionHostExit>,
    state: State<'_, Arc<ExtensionHostState>>,
) -> Result<ExtensionHostStartResult, String> {
    eprintln!("[code-tauri] extension_host_start invoked");
    let root = repo_root()?;
    let bootstrap = root.join("out/bootstrap-fork.js");
    if !bootstrap.exists() {
        return Err(format!(
            "missing {}. Start the VS Code build task first",
            bootstrap.display()
        ));
    }

    // macOS limits Unix-domain socket paths to roughly 104 bytes. `$TMPDIR`
    // is already long, so keep this address under the short `/tmp` alias.
    let socket_path = PathBuf::from("/tmp").join(format!(
        "code-tauri-{}.sock",
        Uuid::new_v4()
    ));
    remove_socket(&socket_path);

    let extension_listener = UnixListener::bind(&socket_path).map_err(|error| {
        format!(
            "failed to bind Extension Host socket {}: {error}",
            socket_path.display()
        )
    })?;
    let webview_listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| error.to_string())?;
    let webview_port = webview_listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let token = Uuid::new_v4().to_string();

    let bun = std::env::var("CODE_TAURI_BUN").unwrap_or_else(|_| "bun".to_owned());
    eprintln!("[code-tauri] spawning Bun from {bun}");
    let mut command = Command::new(bun);
    command
        .current_dir(&root)
        .arg(&bootstrap)
        .arg("--skipWorkspaceStorageLock")
        .env("NODE_ENV", "development")
        .env("VSCODE_DEV", "1")
        .env(
            "VSCODE_ESM_ENTRYPOINT",
            "vs/workbench/api/node/extensionHostProcess",
        )
        .env("VSCODE_HANDLES_UNCAUGHT_ERRORS", "true")
        .env("VSCODE_EXTHOST_IPC_HOOK", &socket_path)
        .env("VSCODE_PARENT_PID", std::process::id().to_string())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn Bun extension host: {error}"))?;
    let pid = child.id().unwrap_or_default();
    eprintln!(
        "[code-tauri] started Bun Extension Host pid={pid}, socket={}",
        socket_path.display()
    );

    if let Some(stdout) = child.stdout.take() {
        tokio::spawn(forward_stdout(stdout, on_stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(forward_stderr(stderr, on_stderr));
    }

    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (stop_sender, mut stop_receiver) = mpsc::channel(1);
    state.hosts.lock().await.insert(
        id,
        ExtensionHostControl {
            stop: stop_sender,
        },
    );

    let managed_state = Arc::clone(state.inner());
    let relay_status = on_status.clone();
    let relay_token = token.clone();
    let relay_socket_path = socket_path.clone();

    on_status
        .send(ExtensionHostStatus::Listening)
        .map_err(|error| error.to_string())?;

    tokio::spawn(async move {
        let relay = run_relay(
            extension_listener,
            webview_listener,
            relay_token,
            relay_status.clone(),
        );

        let exit = tokio::select! {
            result = relay => {
                if let Err(message) = result {
                    let _ = relay_status.send(ExtensionHostStatus::Error { message });
                }
                let _ = child.kill().await;
                child.wait().await
            }
            status = child.wait() => status,
            _ = stop_receiver.recv() => {
                let _ = child.kill().await;
                child.wait().await
            }
        };

        remove_socket(&relay_socket_path);
        managed_state.hosts.lock().await.remove(&id);

        let exit_message = match exit {
            Ok(status) => ExtensionHostExit {
                code: status.code(),
                signal: None,
            },
            Err(error) => ExtensionHostExit {
                code: None,
                signal: Some(error.to_string()),
            },
        };

        eprintln!("[code-tauri] Bun Extension Host exited: {exit_message:?}");
        let _ = on_exit.send(exit_message);
        let _ = relay_status.send(ExtensionHostStatus::Closed);
    });

    Ok(ExtensionHostStartResult {
        id,
        pid,
        websocket_url: format!("ws://127.0.0.1:{webview_port}"),
        token,
    })
}

#[tauri::command]
pub async fn extension_host_stop(
    id: u64,
    state: State<'_, Arc<ExtensionHostState>>,
) -> Result<(), String> {
    let host = state.hosts.lock().await.remove(&id);
    if let Some(host) = host {
        let _ = host.stop.send(()).await;
    }
    Ok(())
}
