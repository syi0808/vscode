(() => {
  // WKWebView does not always expose requestIdleCallback.
  // VS Code only uses it during bootstrap for non-critical canvas warm-up.
  if (
    typeof globalThis.requestIdleCallback
    !== "function"
  ) {
    globalThis.requestIdleCallback = (
      callback,
      options = {},
    ) => {
      const start =
        performance.now();

      const timeout =
        typeof options.timeout === "number"
          ? Math.min(
            options.timeout,
            1,
          )
          : 1;

      return setTimeout(
        () => {
          callback({
            didTimeout: false,

            timeRemaining() {
              return Math.max(
                0,
                50
                - (
                  performance.now()
                  - start
                ),
              );
            },
          });
        },
        timeout,
      );
    };
  }

  if (
    typeof globalThis.cancelIdleCallback
    !== "function"
  ) {
    globalThis.cancelIdleCallback = (
      handle,
    ) => {
      clearTimeout(handle);
    };
  }

  console.log(
    "[code-tauri] preload started",
    globalThis.location?.href,
  );

  Object.defineProperty(
    globalThis,
    "__CODE_TAURI_PRELOAD_LOADED__",
    {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    },
  );

  function invoke(
    command,
    args = {},
    options = undefined,
  ) {
    const internals =
      globalThis.__TAURI_INTERNALS__;

    if (
      !internals ||
      typeof internals.invoke !== "function"
    ) {
      throw new Error(
        "[code-tauri] " +
        "Tauri invoke bridge is unavailable",
      );
    }

    return internals.invoke(
      command,
      args,
      options,
    );
  }

  Object.defineProperty(
    globalThis,
    "__CODE_TAURI__",
    {
      configurable: false,
      enumerable: false,
      writable: false,

      value: {
        invoke,

        async listen(
          event,
          listener,
        ) {
          const handler =
            globalThis.__TAURI_INTERNALS__
              .transformCallback(
                message => listener(message),
              );

          const eventId =
            await invoke(
              "plugin:event|listen",
              {
                event,
                target: { kind: "Any" },
                handler,
              },
            );

          return async () => {
            globalThis
              .__TAURI_EVENT_PLUGIN_INTERNALS__
              .unregisterListener(
                event,
                eventId,
              );
            await invoke(
              "plugin:event|unlisten",
              {
                event,
                eventId,
              },
            );
          };
        },

        invokeRaw(
          command,
          body,
          options,
        ) {
          return invoke(
            command,
            body,
            options,
          );
        },
      },
    },
  );

  const env = {
    VSCODE_DEV: "1",
    NODE_ENV: "development",
  };

  let resolvedConfiguration;

  const listeners =
    new Map();

  function addListener(
    channel,
    listener,
    once,
  ) {
    let entries =
      listeners.get(channel);

    if (!entries) {
      entries =
        new Set();

      listeners.set(
        channel,
        entries,
      );
    }

    entries.add({
      listener,
      once,
    });
  }

  const ipcRenderer = {
    send(
      channel,
      ...args
    ) {
      void invoke(
        "vscode_ipc_send",
        {
          channel,
          args,
        },
      ).catch((error) => {
        console.error(
          "[code-tauri] ipc send failed",
          channel,
          error,
        );
      });
    },

    invoke(
      channel,
      ...args
    ) {
      return invoke(
        "vscode_ipc_invoke",
        {
          channel,
          args,
        },
      );
    },

    on(
      channel,
      listener,
    ) {
      addListener(
        channel,
        listener,
        false,
      );

      return this;
    },

    once(
      channel,
      listener,
    ) {
      addListener(
        channel,
        listener,
        true,
      );

      return this;
    },

    removeListener(
      channel,
      listener,
    ) {
      const entries =
        listeners.get(channel);

      if (!entries) {
        return this;
      }

      for (
        const entry
        of entries
      ) {
        if (
          entry.listener
          === listener
        ) {
          entries.delete(
            entry,
          );
        }
      }

      return this;
    },
  };

  const context = {
    configuration() {
      return resolvedConfiguration;
    },

    async resolveConfiguration() {
      if (
        resolvedConfiguration
      ) {
        return resolvedConfiguration;
      }

      console.log(
        "[code-tauri] " +
        "resolving window configuration",
      );

      resolvedConfiguration =
        await invoke(
          "resolve_window_configuration",
        );

      Object.assign(
        env,
        resolvedConfiguration
          ?.userEnv
        ?? {},
      );

      console.log(
        "[code-tauri] " +
        "window configuration resolved",
        {
          appRoot:
            resolvedConfiguration
              ?.appRoot,

          windowId:
            resolvedConfiguration
              ?.windowId,
        },
      );

      return resolvedConfiguration;
    },
  };

  const process = {
    get platform() {
      const platform =
        navigator.platform
        ?? "";

      if (
        platform.startsWith(
          "Mac",
        )
      ) {
        return "darwin";
      }

      if (
        platform.startsWith(
          "Win",
        )
      ) {
        return "win32";
      }

      return "linux";
    },

    get arch() {
      return (
        resolvedConfiguration
          ?.os
          ?.arch
        ?? "unknown"
      );
    },

    type: "renderer",

    versions: {
      tauri: "2",
    },

    env,

    get execPath() {
      return (
        resolvedConfiguration
          ?.execPath
        ?? ""
      );
    },

    on(
      _type,
      _callback,
    ) {
      // Phase 4:
      // process events are not
      // forwarded yet.
    },

    cwd() {
      return (
        resolvedConfiguration
          ?.appRoot
        ?? "/"
      );
    },

    async shellEnv() {
      return ipcRenderer.invoke(
        "vscode:fetchShellEnv",
      );
    },

    async getProcessMemoryInfo() {
      return {
        private: 0,
        shared: 0,
        residentSet: 0,
      };
    },
  };

  const vscode = {
    ipcRenderer,

    ipcMessagePort: {
      acquire(
        responseChannel,
        nonce,
      ) {
        console.warn(
          "[code-tauri] " +
          "ipcMessagePort.acquire " +
          "not implemented",
          {
            responseChannel,
            nonce,
          },
        );
      },
    },

    webFrame: {
      setZoomLevel(
        level,
      ) {
        void invoke(
          "set_webview_zoom",
          {
            level,
          },
        );
      },
    },

    webUtils: {
      getPathForFile(
        file,
      ) {
        return (
          file?.path
          ?? file?.name
          ?? ""
        );
      },
    },

    process,
    context,
  };

  Object.defineProperty(
    globalThis,
    "vscode",
    {
      configurable: false,
      enumerable: false,
      writable: false,
      value: vscode,
    },
  );

  Object.defineProperty(
    globalThis,
    "_VSCODE_TAURI",
    {
      configurable: false,
      enumerable: false,
      writable: false,
      value: true,
    },
  );

  console.log(
    "[code-tauri] preload ready",
    {
      vscode:
        Boolean(
          globalThis.vscode,
        ),

      tauri:
        Boolean(
          globalThis
            .__TAURI_INTERNALS__,
        ),
    },
  );
})();
