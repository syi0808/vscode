/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISocket, SocketCloseEvent, SocketCloseEventType, SocketDiagnosticsEventType } from '../../../../base/parts/ipc/common/ipc.net.js';

export class TauriWebSocketSocket extends Disposable implements ISocket {

	private readonly _onData = this._register(new Emitter<VSBuffer>());
	readonly onData: Event<VSBuffer> = this._onData.event;

	private readonly _onClose = this._register(new Emitter<SocketCloseEvent>());
	readonly onClose: Event<SocketCloseEvent> = this._onClose.event;

	private readonly _onEnd = this._register(new Emitter<void>());
	readonly onEnd: Event<void> = this._onEnd.event;

	private constructor(private readonly socket: WebSocket) {
		super();
		this.socket.binaryType = 'arraybuffer';

		this.socket.addEventListener('message', event => this._acceptMessage(event.data));
		this.socket.addEventListener('close', event => {
			this._onClose.fire({
				type: SocketCloseEventType.WebSocketCloseEvent,
				code: event.code,
				reason: event.reason,
				wasClean: event.wasClean,
				event
			});
			this._onEnd.fire();
		});
	}

	static connect(url: string, token: string): Promise<TauriWebSocketSocket> {
		return new Promise<TauriWebSocketSocket>((resolve, reject) => {
			const socket = new WebSocket(url);
			const onError = () => {
				cleanup();
				reject(new Error(`Failed to connect to the Bun Extension Host relay at ${url}`));
			};
			const onOpen = () => {
				cleanup();
				socket.send(token);
				resolve(new TauriWebSocketSocket(socket));
			};
			const cleanup = () => {
				socket.removeEventListener('error', onError);
				socket.removeEventListener('open', onOpen);
			};

			socket.addEventListener('error', onError);
			socket.addEventListener('open', onOpen);
		});
	}

	private _acceptMessage(value: string | ArrayBuffer | Blob): void {
		if (value instanceof ArrayBuffer) {
			this._onData.fire(VSBuffer.wrap(new Uint8Array(value)));
			return;
		}

		if (value instanceof Blob) {
			void value.arrayBuffer().then(buffer => {
				this._onData.fire(VSBuffer.wrap(new Uint8Array(buffer)));
			});
			return;
		}

		console.error('[code-tauri] Ignoring non-binary Extension Host relay message.');
	}

	write(buffer: VSBuffer): void {
		if (this.socket.readyState !== WebSocket.OPEN) {
			throw new Error('The Bun Extension Host relay is not open.');
		}

		const bytes = new Uint8Array(buffer.byteLength);
		bytes.set(buffer.buffer);
		this.socket.send(bytes.buffer);
	}

	async drain(): Promise<void> {
		while (this.socket.readyState === WebSocket.OPEN && this.socket.bufferedAmount > 0) {
			await timeout(1);
		}
	}

	end(): void {
		if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
			this.socket.close();
		}
	}

	traceSocketEvent(_type: SocketDiagnosticsEventType, _data?: VSBuffer | Uint8Array | ArrayBuffer | ArrayBufferView): void {
		// Socket diagnostics can be added once the transport is stable.
	}

	override dispose(): void {
		this.end();
		super.dispose();
	}
}
