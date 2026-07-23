/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { CancellationError } from '../../../../base/common/errors.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as objects from '../../../../base/common/objects.js';
import { removeDangerousEnvVariables } from '../../../../base/common/processes.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';
import { getNwipcNativeBinding, NwipcMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.nwipc.js';
import { tauriInvoke } from '../../../../base/parts/sandbox/tauri-browser/globals.js';
import { extensionHostGraceTimeMs, IExtensionHostProcessOptions } from '../../../../platform/extensions/common/extensionHostStarter.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { ILoggerService, ILogService } from '../../../../platform/log/common/log.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IBrowserWorkbenchEnvironmentService } from '../../environment/browser/environmentService.js';
import { IPCExtHostConnection, writeExtHostConnection } from '../common/extensionHostEnv.js';
import { createMessageOfType, isMessageOfType, MessageType, NativeLogMarkers } from '../common/extensionHostProtocol.js';
import { LocalProcessRunningLocation } from '../common/extensionRunningLocation.js';
import { ExtensionHostExtensions, ExtensionHostStartup, IExtensionHost, IExtensionInspectInfo } from '../common/extensions.js';
import { createTauriExtensionHostInitData } from './extensionHostInitData.js';
import { TauriExtensionHostProtocol } from './extensionHostProtocol.js';
import { TauriExtensionHostStarter } from './extensionHostStarter.js';

export interface ITauriLocalProcessExtensionHostInitData {
	readonly extensions: ExtensionHostExtensions;
}

export interface ITauriLocalProcessExtensionHostDataProvider {
	getInitData(): Promise<ITauriLocalProcessExtensionHostInitData>;
}

class ExtensionHostProcess {

	get id(): string { return this._id; }
	get onStdout(): Event<string> { return this._starter.onDynamicStdout(this._id); }
	get onStderr(): Event<string> { return this._starter.onDynamicStderr(this._id); }
	get onExit(): Event<{ code: number; signal: string }> { return this._starter.onDynamicExit(this._id); }

	constructor(
		private readonly _id: string,
		private readonly _starter: TauriExtensionHostStarter
	) { }

	start(options: IExtensionHostProcessOptions): Promise<{ pid: number | undefined }> {
		return this._starter.start(this._id, options);
	}

	waitForExit(maxWaitTimeMs: number): Promise<void> {
		return this._starter.waitForExit(this._id, maxWaitTimeMs);
	}

	kill(): Promise<void> {
		return this._starter.kill(this._id);
	}
}

export class TauriLocalProcessExtensionHost extends Disposable implements IExtensionHost {

	pid: number | null = null;
	readonly remoteAuthority = null;
	extensions: ExtensionHostExtensions | null = null;

	private readonly _onExit = this._register(new Emitter<[number, string]>());
	readonly onExit: Event<[number, string]> = this._onExit.event;

	private _terminating = false;
	private _mainProcessHandlesExtHostShutdown = false;
	private _extensionHostProcess: ExtensionHostProcess | null = null;
	private _messageProtocol: Promise<IMessagePassingProtocol> | null = null;
	private readonly _extensionHostStarter: TauriExtensionHostStarter;

	constructor(
		readonly runningLocation: LocalProcessRunningLocation,
		readonly startup: ExtensionHostStartup.EagerAutoStart | ExtensionHostStartup.EagerManualStart,
		private readonly _initDataProvider: ITauriLocalProcessExtensionHostDataProvider,
		@IWorkspaceContextService private readonly _contextService: IWorkspaceContextService,
		@IBrowserWorkbenchEnvironmentService private readonly _environmentService: IBrowserWorkbenchEnvironmentService,
		@IUserDataProfilesService private readonly _userDataProfilesService: IUserDataProfilesService,
		@ITelemetryService private readonly _telemetryService: ITelemetryService,
		@ILogService private readonly _logService: ILogService,
		@ILoggerService private readonly _loggerService: ILoggerService,
		@ILabelService private readonly _labelService: ILabelService,
		@IProductService private readonly _productService: IProductService
	) {
		super();
		this._extensionHostStarter = this._register(new TauriExtensionHostStarter());
	}

	start(): Promise<IMessagePassingProtocol> {
		if (this._terminating) {
			throw new CancellationError();
		}

		if (!this._messageProtocol) {
			this._messageProtocol = this._start();
		}

		return this._messageProtocol;
	}

	private async _start(): Promise<IMessagePassingProtocol> {
		const [creationResult, configuration] = await Promise.all([
			this._extensionHostStarter.createExtensionHost(),
			tauriInvoke<{ userEnv?: Record<string, string | undefined> }>('resolve_window_configuration')
		]);

		this._extensionHostProcess = new ExtensionHostProcess(creationResult.id, this._extensionHostStarter);
		const env = objects.mixin(configuration.userEnv ?? {}, {
			VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
			VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true'
		});
		removeDangerousEnvVariables(env);
		writeExtHostConnection(new IPCExtHostConnection(extensionHostSocketPath(creationResult.id)), env);

		const options: IExtensionHostProcessOptions = {
			responseWindowId: 0,
			responseChannel: '',
			responseNonce: '',
			env,
			detached: false,
			execArgv: [],
			silent: true
		};

		this._registerProcessListeners(this._extensionHostProcess);

		try {
			const protocol = await this._establishProtocol(this._extensionHostProcess, options);
			await this._performHandshake(protocol);
			return protocol;
		} catch (error) {
			await this._extensionHostProcess.kill().catch(() => undefined);
			throw error;
		}
	}

	private _registerProcessListeners(process: ExtensionHostProcess): void {
		const stdout = this._register(this._handleProcessOutputStream(process.onStdout));
		const stderr = this._register(this._handleProcessOutputStream(process.onStderr));
		this._register(stdout.event(line => console.log('%c[Bun Extension Host]', 'color: #3fb950', line)));
		this._register(stderr.event(line => console.error('[Bun Extension Host]', line)));
		this._register(process.onExit(({ code, signal }) => this._onExtHostProcessExit(code, signal)));
	}

	private _establishProtocol(process: ExtensionHostProcess, options: IExtensionHostProcessOptions): Promise<IMessagePassingProtocol> {
		const directBinding = getNwipcNativeBinding();
		if (directBinding) {
			return process.start(options).then(({ pid }) => {
				this.pid = pid ?? null;
				this._logService.info(`Started local Bun extension host with pid ${pid} using direct NWIPC.`);
				const directProtocol = this._register(new NwipcMessagePassingProtocol(directBinding.connect()));
				this._register(Event.once(directProtocol.onDidClose)(() => void process.kill()));
				return directProtocol;
			});
		}

		const protocol = this._register(new TauriExtensionHostProtocol(process.id, this._extensionHostStarter));

		return new Promise<IMessagePassingProtocol>((resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				connected.dispose();
				reject(new Error('The local extension host took longer than 60s to connect.'));
			}, 60_000);

			const connected = protocol.onDidConnect(() => {
				clearTimeout(timeoutHandle);
				connected.dispose();
				resolve(protocol);
			});

			void process.start(options).then(({ pid }) => {
				this.pid = pid ?? null;
				this._logService.info(`Started local Bun extension host with pid ${pid}.`);
			}, error => {
				clearTimeout(timeoutHandle);
				connected.dispose();
				reject(error);
			});
		});
	}

	private _performHandshake(protocol: IMessagePassingProtocol): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let timeoutHandle: Timeout;
			const installTimeout = () => {
				timeoutHandle = setTimeout(() => reject(new Error('The local extension host took longer than 60s to complete its handshake.')), 60_000);
			};
			const disposable = protocol.onMessage(message => {
				if (isMessageOfType(message, MessageType.Ready)) {
					clearTimeout(timeoutHandle);
					void this._createExtHostInitData().then(data => {
						installTimeout();
						protocol.send(VSBuffer.fromString(JSON.stringify(data)));
					}, reject);
					return;
				}

				if (isMessageOfType(message, MessageType.Initialized)) {
					clearTimeout(timeoutHandle);
					disposable.dispose();
					resolve();
				}
			});
			installTimeout();
		});
	}

	private async _createExtHostInitData() {
		const init = await this._initDataProvider.getInitData();
		this.extensions = init.extensions;
		return createTauriExtensionHostInitData({
			contextService: this._contextService,
			environmentService: this._environmentService,
			userDataProfilesService: this._userDataProfilesService,
			telemetryService: this._telemetryService,
			logService: this._logService,
			loggerService: this._loggerService,
			labelService: this._labelService,
			productService: this._productService
		}, init.extensions, this.startup === ExtensionHostStartup.EagerAutoStart);
	}

	private _onExtHostProcessExit(code: number, signal: string): void {
		if (!this._terminating) {
			this._onExit.fire([code, signal]);
		}
	}

	private _handleProcessOutputStream(stream: Event<string>): Emitter<string> {
		let last = '';
		let isOmitting = false;
		const event = new Emitter<string>();
		stream(chunk => {
			last += chunk;
			const lines = last.split(/\r?\n/g);
			last = lines.pop()!;
			if (last.length > 10_000) {
				lines.push(last);
				last = '';
			}
			for (const line of lines) {
				if (isOmitting) {
					isOmitting = line !== NativeLogMarkers.End;
				} else if (line === NativeLogMarkers.Start) {
					isOmitting = true;
				} else if (line.length) {
					event.fire(`${line}\n`);
				}
			}
		}, undefined, this._store);
		return event;
	}

	async disconnect(): Promise<void> {
		this._terminating = true;
		if (this._messageProtocol) {
			const protocol = await Promise.race([
				this._messageProtocol.then(value => value, () => undefined),
				timeout(1000).then(() => undefined)
			]);
			if (protocol) {
				protocol.send(createMessageOfType(MessageType.Terminate));
				if (protocol instanceof TauriExtensionHostProtocol) {
					await protocol.drain().catch(() => undefined);
				}
			}
		}

		if (this._extensionHostProcess && !this._mainProcessHandlesExtHostShutdown) {
			await this._extensionHostProcess.waitForExit(extensionHostGraceTimeMs).catch(() => undefined);
		}
		this._messageProtocol = null;
	}

	getInspectPort(): IExtensionInspectInfo | undefined { return undefined; }
	enableInspectPort(): Promise<boolean> { return Promise.resolve(false); }

	override dispose(): void {
		void this.disconnect();
		super.dispose();
	}
}

function extensionHostSocketPath(id: string): string {
	return `/tmp/vscode-tauri/ext-host-${id}.sock`;
}
