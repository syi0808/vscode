/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';
import { tauriInvoke } from '../../../../base/parts/sandbox/tauri-browser/globals.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILoggerService, ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { createMessageOfType, isMessageOfType, MessageType } from '../common/extensionHostProtocol.js';
import { LocalProcessRunningLocation } from '../common/extensionRunningLocation.js';
import { ExtensionHostExtensions, ExtensionHostStartup, IExtensionHost, IExtensionInspectInfo } from '../common/extensions.js';
import { IExtensionHostRuntime, IExtensionHostRuntimeSession } from './extensionHostRuntime.js';
import { createTauriExtensionHostInitData } from './extensionHostInitData.js';

export interface ITauriLocalProcessExtensionHostInitData {
	readonly extensions: ExtensionHostExtensions;
}

export interface ITauriLocalProcessExtensionHostDataProvider {
	getInitData(): Promise<ITauriLocalProcessExtensionHostInitData>;
}

export class TauriLocalProcessExtensionHost extends Disposable implements IExtensionHost {

	pid: number | null = null;
	readonly remoteAuthority = null;
	extensions: ExtensionHostExtensions | null = null;

	private readonly _onExit = this._register(new Emitter<[number, string | null]>());
	readonly onExit: Event<[number, string | null]> = this._onExit.event;

	private terminating = false;
	private session: IExtensionHostRuntimeSession | undefined;
	private protocolPromise: Promise<IMessagePassingProtocol> | undefined;

	constructor(
		readonly runningLocation: LocalProcessRunningLocation,
		readonly startup: ExtensionHostStartup.EagerAutoStart | ExtensionHostStartup.EagerManualStart,
		private readonly initDataProvider: ITauriLocalProcessExtensionHostDataProvider,
		private readonly runtime: IExtensionHostRuntime,
		@IWorkspaceContextService private readonly contextService: IWorkspaceContextService,
		@IBrowserWorkbenchEnvironmentService private readonly environmentService: IBrowserWorkbenchEnvironmentService,
		@IUserDataProfilesService private readonly userDataProfilesService: IUserDataProfilesService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILogService private readonly logService: ILogService,
		@ILoggerService private readonly loggerService: ILoggerService,
		@ILabelService private readonly labelService: ILabelService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
	}

	start(): Promise<IMessagePassingProtocol> {
		if (this.terminating) {
			throw new CancellationError();
		}

		if (!this.protocolPromise) {
			this.protocolPromise = this.startRuntime();
		}

		return this.protocolPromise;
	}

	private async startRuntime(): Promise<IMessagePassingProtocol> {
		try {
			const session = await this.runtime.start();
			this.session = session;
			this.pid = session.pid;
			this._register(session.onExit(exit => {
				if (!this.terminating) {
					this._onExit.fire([exit.code ?? 0, exit.signal]);
				}
			}));

			await this.performHandshake(session.protocol);
			await tauriInvokeLog(`Bun Extension Host initialized, pid=${session.pid}`);
			return session.protocol;
		} catch (error) {
			await tauriInvokeLog(`Bun Extension Host startup failed: ${String(error)}`);
			throw error;
		}
	}

	private async performHandshake(protocol: IMessagePassingProtocol): Promise<void> {
		await this.waitForMessage(protocol, MessageType.Ready, 'ready');
		await tauriInvokeLog('Bun Extension Host sent Ready');

		const init = await this.initDataProvider.getInitData();
		this.extensions = init.extensions;
		await tauriInvokeLog(
			`Extension Host init all=[${init.extensions.allExtensions.map(extension => extension.identifier.value).join(', ')}] ` +
			`mine=[${init.extensions.myExtensions.map(extension => extension.value).join(', ')}]`
		);

		const initialized = this.waitForMessage(protocol, MessageType.Initialized, 'initialized');
		const data = await createTauriExtensionHostInitData(
			{
				contextService: this.contextService,
				environmentService: this.environmentService,
				userDataProfilesService: this.userDataProfilesService,
				telemetryService: this.telemetryService,
				logService: this.logService,
				loggerService: this.loggerService,
				labelService: this.labelService,
				productService: this.productService
			},
			init.extensions,
			this.startup === ExtensionHostStartup.EagerAutoStart
		);

		protocol.send(VSBuffer.fromString(JSON.stringify(data)));
		await initialized;
	}

	private waitForMessage(protocol: IMessagePassingProtocol, expected: MessageType, phase: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			const handle = setTimeout(() => {
				disposable.dispose();
				reject(new Error(`The Bun Extension Host did not complete the ${phase} phase within 60 seconds.`));
			}, 60_000);

			const disposable = protocol.onMessage(message => {
				if (!isMessageOfType(message, expected)) {
					return;
				}

				clearTimeout(handle);
				disposable.dispose();
				resolve();
			});
		});
	}

	async disconnect(): Promise<void> {
		if (this.terminating) {
			return;
		}

		this.terminating = true;
		if (this.session) {
			try {
				this.session.protocol.send(createMessageOfType(MessageType.Terminate));
				await Promise.race([
					Event.toPromise(this.session.onExit),
					timeout(1000)
				]);
			} catch {
				// The Extension Host may have already exited.
			}

			await this.session.terminate();
			this.session = undefined;
		}
	}

	getInspectPort(): IExtensionInspectInfo | undefined {
		return undefined;
	}

	enableInspectPort(): Promise<boolean> {
		return Promise.resolve(false);
	}

	override dispose(): void {
		void this.disconnect();
		super.dispose();
	}
}

function tauriInvokeLog(message: string): Promise<void> {
	return tauriInvoke('code_tauri_log', { message });
}
