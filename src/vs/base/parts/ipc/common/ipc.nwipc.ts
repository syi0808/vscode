/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../common/buffer.js';
import { Emitter } from '../../../common/event.js';
import { Disposable } from '../../../common/lifecycle.js';
import { IMessagePassingProtocol } from './ipc.js';
import { BufferedEmitter } from './ipc.net.js';

export type NwipcSendDisposition = 'sent' | 'backpressured';

export interface INwipcNativePortHandler {
	message(payload: Uint8Array): void;
	writable(): void;
	close(): void;
	error(code: string): void;
}

export interface INwipcNativePort {
	readonly bufferedAmount: number;
	send(payload: Uint8Array): NwipcSendDisposition;
	close(): void;
	setHandler(handler: INwipcNativePortHandler | undefined): void;
}

export interface INwipcNativeBinding {
	connect(): INwipcNativePort;
}

interface INwipcGlobal {
	readonly __nwipc?: INwipcNativeBinding;
}

export function getNwipcNativeBinding(): INwipcNativeBinding | undefined {
	return (globalThis as typeof globalThis & INwipcGlobal).__nwipc;
}

export class NwipcMessagePassingProtocol extends Disposable implements IMessagePassingProtocol {

	private readonly _onMessage = new BufferedEmitter<VSBuffer>();
	readonly onMessage = this._onMessage.event;

	private readonly _onDidClose = this._register(new Emitter<void>());
	readonly onDidClose = this._onDidClose.event;

	private readonly _pending: Uint8Array[] = [];
	private readonly _drainWaiters: Array<() => void> = [];
	private _backpressured = false;
	private _closed = false;

	constructor(private readonly port: INwipcNativePort) {
		super();
		port.setHandler({
			message: payload => this._onMessage.fire(VSBuffer.wrap(payload.slice())),
			writable: () => this._flush(),
			close: () => this._close(false),
			error: () => this._close(false)
		});
	}

	send(message: VSBuffer): void {
		if (this._closed) {
			return;
		}

		const payload = message.buffer.slice();
		if (this._backpressured) {
			this._pending.push(payload);
			return;
		}

		try {
			this._backpressured = this.port.send(payload) === 'backpressured';
		} catch {
			this._close(false);
		}
	}

	drain(): Promise<void> {
		if (!this._backpressured && this._pending.length === 0) {
			return Promise.resolve();
		}

		return new Promise(resolve => this._drainWaiters.push(resolve));
	}

	private _flush(): void {
		if (this._closed) {
			return;
		}

		this._backpressured = false;
		while (!this._backpressured && this._pending.length > 0) {
			const payload = this._pending.shift()!;
			try {
				this._backpressured = this.port.send(payload) === 'backpressured';
			} catch {
				this._close(false);
				return;
			}
		}
		if (!this._backpressured) {
			this._resolveDrainWaiters();
		}
	}

	private _close(closeNativePort: boolean): void {
		if (this._closed) {
			return;
		}

		this._closed = true;
		this._pending.length = 0;
		this.port.setHandler(undefined);
		if (closeNativePort) {
			this.port.close();
		}
		this._onMessage.flushBuffer();
		this._resolveDrainWaiters();
		this._onDidClose.fire();
	}

	private _resolveDrainWaiters(): void {
		for (const resolve of this._drainWaiters.splice(0)) {
			resolve();
		}
	}

	override dispose(): void {
		this._close(true);
		super.dispose();
	}
}

export function connectNwipcMessagePassingProtocol(): NwipcMessagePassingProtocol | undefined {
	const binding = getNwipcNativeBinding();
	return binding ? new NwipcMessagePassingProtocol(binding.connect()) : undefined;
}
