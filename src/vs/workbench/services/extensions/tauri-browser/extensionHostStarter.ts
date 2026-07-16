/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { tauriInvoke, tauriListen } from '../../../../base/parts/sandbox/tauri-browser/globals.js';
import { IExtensionHostProcessOptions, IExtensionHostStarter } from '../../../../platform/extensions/common/extensionHostStarter.js';

export const enum TauriExtensionHostEvent {
	Connected = 'vscode://extension-host/connected',
	Stdout = 'vscode://extension-host/stdout',
	Stderr = 'vscode://extension-host/stderr',
	Message = 'vscode://extension-host/message',
	Exit = 'vscode://extension-host/exit'
}

interface IExtensionHostOutputEvent {
	readonly id: string;
	readonly data: string;
}

export interface IExtensionHostMessageEvent {
	readonly id: string;
	readonly data: number[];
}

export interface IExtensionHostExitEvent {
	readonly id: string;
	readonly code: number;
	readonly signal: string;
}

export interface IExtensionHostConnectedEvent {
	readonly id: string;
}

export interface ITauriExtensionHostEventSource {
	readonly onMessageEvent: Event<IExtensionHostMessageEvent>;
	readonly onConnectedEvent: Event<IExtensionHostConnectedEvent>;
}

/**
 * Adapts the Tauri extension host commands and global events to the native
 * extension host starter contract.
 */
export class TauriExtensionHostStarter extends Disposable implements IExtensionHostStarter {

	declare readonly _serviceBrand: undefined;

	private readonly _onDynamicStdout = this._register(new Emitter<IExtensionHostOutputEvent>());
	private readonly _onDynamicStderr = this._register(new Emitter<IExtensionHostOutputEvent>());
	private readonly _onDynamicMessage = this._register(new Emitter<IExtensionHostMessageEvent>());
	private readonly _onDynamicExit = this._register(new Emitter<IExtensionHostExitEvent>());
	private readonly _onDynamicConnected = this._register(new Emitter<IExtensionHostConnectedEvent>());
	readonly onMessageEvent = this._onDynamicMessage.event;
	readonly onConnectedEvent = this._onDynamicConnected.event;

	private readonly _listenersReady: Promise<void>;

	constructor() {
		super();
		this._listenersReady = Promise.all([
			this._listen(TauriExtensionHostEvent.Stdout, this._onDynamicStdout),
			this._listen(TauriExtensionHostEvent.Stderr, this._onDynamicStderr),
			this._listen(TauriExtensionHostEvent.Message, this._onDynamicMessage),
			this._listen(TauriExtensionHostEvent.Exit, this._onDynamicExit),
			this._listen(TauriExtensionHostEvent.Connected, this._onDynamicConnected)
		]).then(() => undefined);
	}

	private async _listen<T>(event: TauriExtensionHostEvent, emitter: Emitter<T>): Promise<void> {
		const unlisten = await tauriListen<T>(event, value => emitter.fire(value.payload));
		this._register(toDisposable(() => void unlisten()));
	}

	whenReady(): Promise<void> {
		return this._listenersReady;
	}

	onDynamicStdout(id: string): Event<string> {
		return Event.map(Event.filter(this._onDynamicStdout.event, event => event.id === id), event => event.data);
	}

	onDynamicStderr(id: string): Event<string> {
		return Event.map(Event.filter(this._onDynamicStderr.event, event => event.id === id), event => event.data);
	}

	onDynamicMessage(id: string): Event<IExtensionHostMessageEvent> {
		return Event.filter(this._onDynamicMessage.event, event => event.id === id);
	}

	onDynamicExit(id: string): Event<{ code: number; signal: string }> {
		return Event.map(Event.filter(this._onDynamicExit.event, event => event.id === id), event => ({ code: event.code, signal: event.signal }));
	}

	onDynamicConnected(id: string): Event<void> {
		return Event.map(Event.filter(this._onDynamicConnected.event, event => event.id === id), () => undefined);
	}

	async createExtensionHost(): Promise<{ id: string }> {
		await this._listenersReady;
		return tauriInvoke('ext_host_create');
	}

	async start(id: string, opts: IExtensionHostProcessOptions): Promise<{ pid: number | undefined }> {
		await this._listenersReady;
		return tauriInvoke('ext_host_start', { id, options: opts });
	}

	enableInspectPort(_id: string): Promise<boolean> {
		return Promise.resolve(false);
	}

	async waitForExit(id: string, maxWaitTimeMs: number): Promise<void> {
		await tauriInvoke('ext_host_wait_for_exit', { id, maxWaitTimeMs });
	}

	async kill(id: string): Promise<void> {
		await tauriInvoke('ext_host_kill', { id });
	}
}
