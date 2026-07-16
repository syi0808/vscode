/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';
import { BufferedEmitter } from '../../../../base/parts/ipc/common/ipc.net.js';
import { tauriInvoke } from '../../../../base/parts/sandbox/tauri-browser/globals.js';
import { ITauriExtensionHostEventSource } from './extensionHostStarter.js';

export type TauriExtensionHostSend = (id: string, data: number[]) => Promise<void>;

/** Bridges raw extension host bytes across the Tauri command/event boundary. */
export class TauriExtensionHostProtocol extends Disposable implements IMessagePassingProtocol {

	private readonly _onMessage = new BufferedEmitter<VSBuffer>();
	readonly onMessage = this._onMessage.event;

	private readonly _onDidConnect = this._register(new Emitter<void>());
	readonly onDidConnect: Event<void> = this._onDidConnect.event;
	private sendQueue: Promise<void> = Promise.resolve();

	constructor(
		private readonly id: string,
		events: ITauriExtensionHostEventSource,
		private readonly invokeSend: TauriExtensionHostSend = (id, data) => tauriInvoke('ext_host_send', { id, data })
	) {
		super();
		this._register(events.onMessageEvent(event => {
			if (event.id !== id) {
				return;
			}
			this._onMessage.fire(VSBuffer.wrap(Uint8Array.from(event.data)));
		}));
		this._register(events.onConnectedEvent(event => {
			if (event.id === id) {
				this._onDidConnect.fire();
			}
		}));
	}

	send(message: VSBuffer): void {
		const data = Array.from(message.buffer);
		this.sendQueue = this.sendQueue.then(
			() => this.invokeSend(this.id, data),
			() => this.invokeSend(this.id, data)
		).catch(() => undefined);
	}

	drain(): Promise<void> {
		return this.sendQueue;
	}

	override dispose(): void {
		this._onMessage.flushBuffer();
		super.dispose();
	}
}
