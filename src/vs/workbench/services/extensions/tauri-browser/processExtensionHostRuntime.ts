/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { PersistentProtocol } from '../../../../base/parts/ipc/common/ipc.net.js';
import { tauriCreateChannel, tauriInvoke } from '../../../../base/parts/sandbox/tauri-browser/globals.js';
import { IExtensionHostRuntime, IExtensionHostRuntimeExit, IExtensionHostRuntimeSession } from './extensionHostRuntime.js';
import { TauriWebSocketSocket } from './webSocketSocket.js';

interface IExtensionHostStartResult {
	readonly id: number;
	readonly pid: number;
	readonly websocketUrl: string;
	readonly token: string;
}

interface IExtensionHostStatus {
	readonly type: 'listening' | 'extensionHostConnected' | 'webviewConnected' | 'bridging' | 'closed' | 'error';
	readonly message?: string;
}

class BunProcessExtensionHostRuntimeSession extends Disposable implements IExtensionHostRuntimeSession {

	private terminating = false;

	constructor(
		private readonly id: number,
		readonly pid: number,
		readonly protocol: PersistentProtocol,
		readonly onExit: Event<IExtensionHostRuntimeExit>,
		private readonly socket: TauriWebSocketSocket,
		private readonly channels: DisposableStore,
	) {
		super();
		this._register(this.socket);
		this._register(this.channels);
	}

	async terminate(): Promise<void> {
		if (this.terminating) {
			return;
		}

		this.terminating = true;
		this.protocol.sendDisconnect();
		await this.protocol.drain().catch(() => undefined);
		this.protocol.dispose();
		this.socket.end();
		await tauriInvoke('extension_host_stop', { id: this.id });
	}

	override dispose(): void {
		void this.terminate();
		super.dispose();
	}
}

export class BunProcessExtensionHostRuntime implements IExtensionHostRuntime {

	async start(): Promise<IExtensionHostRuntimeSession> {
		await tauriInvoke('code_tauri_log', { message: 'BunProcessExtensionHostRuntime.start()' });
		const channels = new DisposableStore();
		const onExitEmitter = new Emitter<IExtensionHostRuntimeExit>();
		channels.add(onExitEmitter);

		const stdout = tauriCreateChannel<string>(line => {
			console.log('%c[Bun Extension Host]', 'color: #3fb950', line);
		});
		const stderr = tauriCreateChannel<string>(line => {
			console.error('[Bun Extension Host]', line);
		});
		const status = tauriCreateChannel<IExtensionHostStatus>(value => {
			if (value.type === 'error') {
				console.error('[code-tauri] Extension Host relay error:', value.message);
			} else {
				console.debug('[code-tauri] Extension Host relay:', value.type);
			}
		});
		const exit = tauriCreateChannel<IExtensionHostRuntimeExit>(value => {
			onExitEmitter.fire(value);
		});

		for (const channel of [stdout, stderr, status, exit]) {
			channels.add({ dispose: () => channel.dispose() });
		}

		try {
			const result = await tauriInvoke<IExtensionHostStartResult>('extension_host_start', {
				onStdout: stdout,
				onStderr: stderr,
				onStatus: status,
				onExit: exit
			});
			const socket = await TauriWebSocketSocket.connect(result.websocketUrl, result.token);
			const protocol = new PersistentProtocol({ socket });
			protocol.sendResume();

			return new BunProcessExtensionHostRuntimeSession(
				result.id,
				result.pid,
				protocol,
				onExitEmitter.event,
				socket,
				channels
			);
		} catch (error) {
			channels.dispose();
			throw error;
		}
	}
}
