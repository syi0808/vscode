(() => {
  class CodeTauriChannel {
    constructor(onmessage = () => {}) {
      this._onmessage = onmessage;
      this._nextMessageIndex = 0;
      this._pendingMessages = [];
      this._messageEndIndex = undefined;
      this._disposed = false;

      this.id =
        globalThis.__TAURI_INTERNALS__
          .transformCallback(
            (rawMessage) => {
              const index =
                rawMessage.index;

              if (
                "end"
                in rawMessage
              ) {
                if (
                  index
                  === this._nextMessageIndex
                ) {
                  this.dispose();
                } else {
                  this._messageEndIndex =
                    index;
                }

                return;
              }

              const message =
                rawMessage.message;

              if (
                index
                === this._nextMessageIndex
              ) {
                this._onmessage(
                  message,
                );

                this._nextMessageIndex += 1;

                while (
                  this._pendingMessages[
                    this._nextMessageIndex
                  ] !== undefined
                ) {
                  const pending =
                    this._pendingMessages[
                      this._nextMessageIndex
                    ];

                  delete this
                    ._pendingMessages[
                      this._nextMessageIndex
                    ];

                  this._onmessage(
                    pending,
                  );

                  this._nextMessageIndex += 1;
                }

                if (
                  this._nextMessageIndex
                  === this._messageEndIndex
                ) {
                  this.dispose();
                }
              } else {
                this._pendingMessages[
                  index
                ] = message;
              }
            },
          );
    }

    set onmessage(handler) {
      this._onmessage = handler;
    }

    get onmessage() {
      return this._onmessage;
    }

    toJSON() {
      return `__CHANNEL__:${this.id}`;
    }

    dispose() {
      if (this._disposed) {
        return;
      }

      this._disposed = true;

      globalThis.__TAURI_INTERNALS__
        .unregisterCallback(
          this.id,
        );
    }
  }

  Object.defineProperty(
    globalThis,
    "__CODE_TAURI_CREATE_CHANNEL__",
    {
      configurable: false,
      enumerable: false,
      writable: false,

      value(onmessage) {
        return new CodeTauriChannel(
          onmessage,
        );
      },
    },
  );
})();
