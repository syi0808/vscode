use std::sync::{Arc, Mutex};

use nwipc::Session;

pub struct DirectIpcState {
    _runtime: Mutex<nwipc::Nwipc>,
    session: Mutex<Option<Session>>,
}

impl DirectIpcState {
    pub fn initialize() -> Result<(Arc<Self>, Vec<u8>), String> {
        let mut runtime = nwipc::Nwipc::initialize().map_err(|error| error.to_string())?;
        let mut session = runtime
            .create_session()
            .map_err(|error| error.to_string())?;
        let mut renderer_bootstrap = Vec::new();
        session
            .write_renderer_bootstrap(&mut renderer_bootstrap)
            .map_err(|error| error.to_string())?;
        Ok((
            Arc::new(Self {
                _runtime: Mutex::new(runtime),
                session: Mutex::new(Some(session)),
            }),
            renderer_bootstrap,
        ))
    }

    pub fn take_peer_session(&self) -> Result<Session, String> {
        self.session
            .lock()
            .map_err(|_| "NWIPC session lock is poisoned".to_owned())?
            .take()
            .ok_or_else(|| "NWIPC peer session has already been consumed".to_owned())
    }

    pub fn with_session<Output>(&self, callback: impl FnOnce(&Session) -> Output) -> Output {
        let session = self.session.lock().expect("NWIPC session lock is poisoned");
        callback(session.as_ref().expect("NWIPC session must be available"))
    }
}

#[cfg(target_os = "macos")]
pub mod macos {
    use std::path::{Path, PathBuf};

    use nwipc_error::{ErrorCategory, ErrorCode, ErrorReport, Recoverability};
    use nwipc_macos_host::WebViewConfigurator;
    use nwipc_macos_spi::SystemSpiProbe;
    use nwipc_tauri::{TauriAdapter, TauriWebViewConfiguration};
    use objc2::{
        msg_send,
        rc::Retained,
        runtime::{AnyClass, AnyObject},
        MainThreadMarker,
    };
    use objc2_foundation::{NSString, NSURL};
    use objc2_web_kit::WKWebViewConfiguration;
    use tauri::{Manager, Runtime, WebviewWindowBuilder};

    const RENDERER_BOOTSTRAP_PARAMETER: &str = "nwipc.renderer-bootstrap";
    const MODE_PARAMETER: &str = "nwipc.mode";

    pub struct Configuration {
        webview: Retained<WKWebViewConfiguration>,
        process_pool_configuration: Retained<AnyObject>,
        process_pool: Option<Retained<AnyObject>>,
    }

    impl Configuration {
        pub fn new() -> Result<Self, String> {
            let main_thread = MainThreadMarker::new()
                .ok_or_else(|| "WebKit configuration must run on the main thread".to_owned())?;
            let class = AnyClass::get(c"_WKProcessPoolConfiguration")
                .ok_or_else(|| "_WKProcessPoolConfiguration is unavailable".to_owned())?;
            let process_pool_configuration = unsafe { msg_send![class, new] };
            Ok(Self {
                webview: unsafe { WKWebViewConfiguration::new(main_thread) },
                process_pool_configuration,
                process_pool: None,
            })
        }
    }

    impl WebViewConfigurator for Configuration {
        fn set_injected_bundle(&mut self, path: &Path) -> Result<(), ErrorReport> {
            let path = NSString::from_str(&path.to_string_lossy());
            let url = NSURL::fileURLWithPath(&path);
            unsafe {
                let _: () = msg_send![
                    &self.process_pool_configuration,
                    setInjectedBundleURL: &*url
                ];
            }
            Ok(())
        }

        fn set_initialization_data(&mut self, data: &[u8]) -> Result<(), ErrorReport> {
            let value = NSString::from_str(&hex(data));
            let key = NSString::from_str(RENDERER_BOOTSTRAP_PARAMETER);
            let mode = NSString::from_str("renderer");
            let mode_key = NSString::from_str(MODE_PARAMETER);
            let process_pool = self.process_pool()?;
            unsafe {
                let _: () = msg_send![
                    &process_pool,
                    _setObject: &*mode,
                    forBundleParameter: &*mode_key
                ];
                let _: () = msg_send![
                    &process_pool,
                    _setObject: &*value,
                    forBundleParameter: &*key
                ];
            }
            self.process_pool = Some(process_pool);
            Ok(())
        }

        fn commit_process_pool_configuration(&mut self) -> Result<(), ErrorReport> {
            let process_pool = match self.process_pool.take() {
                Some(process_pool) => process_pool,
                None => self.process_pool()?,
            };
            unsafe {
                let _: () = msg_send![&self.webview, setProcessPool: &*process_pool];
            }
            self.process_pool = Some(process_pool);
            Ok(())
        }
    }

    impl Configuration {
        fn process_pool(&self) -> Result<Retained<AnyObject>, ErrorReport> {
            let class = AnyClass::get(c"WKProcessPool")
                .ok_or_else(|| platform_error("WKProcessPool class"))?;
            let allocated: *mut AnyObject = unsafe { msg_send![class, alloc] };
            let process_pool: *mut AnyObject = unsafe {
                msg_send![
                    allocated,
                    _initWithConfiguration: &*self.process_pool_configuration
                ]
            };
            let process_pool = unsafe { Retained::from_raw(process_pool) }
                .ok_or_else(|| platform_error("WKProcessPool configuration"))?;
            Ok(process_pool)
        }
    }

    impl<'a, R: Runtime, M: Manager<R>> TauriWebViewConfiguration<'a, R, M> for Configuration {
        fn merge(self, builder: WebviewWindowBuilder<'a, R, M>) -> WebviewWindowBuilder<'a, R, M> {
            builder.with_webview_configuration(self.webview)
        }
    }

    pub fn adapter(root: &Path, bootstrap: &[u8]) -> Result<TauriAdapter, String> {
        TauriAdapter::configure(&SystemSpiProbe, bundle_path(root), bootstrap)
            .map_err(|error| error.to_string())
    }

    fn bundle_path(root: &Path) -> PathBuf {
        let packaged = std::env::current_exe().ok().and_then(|executable| {
            executable
                .parent()?
                .parent()
                .map(|contents| contents.join("Resources/NWIPC.bundle"))
        });
        std::env::var_os("CODE_TAURI_NWIPC_BUNDLE")
            .map(PathBuf::from)
            .or_else(|| packaged.filter(|path| path.is_dir()))
            .unwrap_or_else(|| root.join("src-tauri/binaries/NWIPC.bundle"))
    }

    fn hex(bytes: &[u8]) -> String {
        const DIGITS: &[u8; 16] = b"0123456789abcdef";
        let mut encoded = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            encoded.push(char::from(DIGITS[usize::from(byte >> 4)]));
            encoded.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
        }
        encoded
    }

    fn platform_error(operation: &'static str) -> ErrorReport {
        ErrorReport::new(
            ErrorCategory::Platform,
            ErrorCode::Unsupported,
            Recoverability::Terminal,
            operation,
        )
    }
}
