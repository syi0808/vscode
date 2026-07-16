/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm } from 'fs/promises';
import { createServer, Server, Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { DisposableMap, DisposableStore } from '../../../../base/common/lifecycle.js';
import { revive } from '../../../../base/common/marshalling.js';
import { URI } from '../../../../base/common/uri.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';
import { PersistentProtocol } from '../../../../base/parts/ipc/common/ipc.net.js';
import { NodeSocket } from '../../../../base/parts/ipc/node/ipc.net.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ConfigurationModel } from '../../../../platform/configuration/common/configurationModels.js';
import { ExtensionIdentifier, IExtensionDescription, IExtensionManifest, TargetPlatform } from '../../../../platform/extensions/common/extensions.js';
import { InstantiationService } from '../../../../platform/instantiation/common/instantiationService.js';
import { LogLevel, NullLogService } from '../../../../platform/log/common/log.js';
import { ExtHostCommandsShape, ExtHostContext, IConfigurationInitData, IWorkspaceData, MainContext, MainThreadCommandsShape } from '../../../api/common/extHost.protocol.js';
import { ActivationKind, ExtensionHostExtensions } from '../../../services/extensions/common/extensions.js';
import { ExtensionHostKind } from '../../../services/extensions/common/extensionHostKind.js';
import { createMessageOfType, IExtensionHostInitData, isMessageOfType, MessageType, UIKind } from '../../../services/extensions/common/extensionHostProtocol.js';
import { IExtHostContext } from '../../../services/extensions/common/extHostCustomers.js';
import { ProxyIdentifier } from '../../../services/extensions/common/proxyIdentifier.js';
import { RPCProtocol } from '../../../services/extensions/common/rpcProtocol.js';

const cjsCommandId = 'bunFixture.cjs';
const esmCommandId = 'bunFixture.esm';
const mixedCommandId = 'bunFixture.mixed';
const cjsExtensionId = new ExtensionIdentifier('vscode-test.vscode-bun-fixture-cjs');
const esmExtensionId = new ExtensionIdentifier('vscode-test.vscode-bun-fixture-esm');
const mixedExtensionId = new ExtensionIdentifier('vscode-test.vscode-bun-fixture-mixed');
const cjsDeactivateSentinel = '[vscode-test-bun-cjs] deactivate';
const esmDeactivateSentinel = '[vscode-test-bun-esm] deactivate';
const mixedDeactivateSentinel = '[vscode-test-bun-mixed] deactivate';

export interface IBunCjsFixtureResult {
	readonly kind: string;
	readonly nestedKind: string;
	readonly hasWorkspaceApi: boolean;
	readonly extensionPath: string;
	readonly deactivated: boolean;
	readonly commandsDistinctFromEsm: boolean;
	readonly workspaceDistinctFromEsm: boolean;
}

export interface IBunEsmFixtureResult {
	readonly kind: string;
	readonly staticDynamicMatch: boolean;
}

export interface IBunMixedFixtureResult {
	readonly kind: string;
	readonly commandsIdentity: boolean;
	readonly workspaceIdentity: boolean;
	readonly commandsDistinctFromOtherExtensions: boolean;
	readonly workspaceDistinctFromOtherExtensions: boolean;
	readonly esmCommandResult: IBunEsmFixtureResult;
}

export interface IBunExtensionHostFixtureRun {
	readonly cjsResult: IBunCjsFixtureResult;
	readonly esmResult: IBunEsmFixtureResult;
	readonly mixedResult: IBunMixedFixtureResult;
	readonly activatedExtensionIds: readonly string[];
	readonly cjsCommandRegistered: boolean;
	readonly esmCommandRegistered: boolean;
	readonly mixedCommandRegistered: boolean;
	readonly cjsDeactivated: boolean;
	readonly esmDeactivated: boolean;
	readonly mixedDeactivated: boolean;
	readonly output: string;
	readonly fixtureFilesBefore: readonly string[];
	readonly fixtureFilesAfter: readonly string[];
	readonly bunCacheFiles: readonly string[];
}

interface IRunningHost {
	readonly child: ChildProcessWithoutNullStreams;
	readonly server: Server;
	readonly protocol: PersistentProtocol;
	readonly output: string[];
}

class BunFixtureMainThreadCommands implements MainThreadCommandsShape {

	private readonly registrations = new DisposableMap<string>();

	constructor(private readonly proxy: ExtHostCommandsShape) { }

	$registerCommand(id: string): void {
		this.registrations.set(id, CommandsRegistry.registerCommand(id, (_accessor, ...args) => {
			return this.proxy.$executeContributedCommand(id, ...args).then(result => revive(result));
		}));
	}

	$unregisterCommand(id: string): void {
		this.registrations.deleteAndDispose(id);
	}

	$fireCommandActivationEvent(): void { }

	async $executeCommand<T>(id: string, args: object[]): Promise<T | undefined> {
		const command = CommandsRegistry.getCommand(id);
		if (!command) {
			return undefined;
		}
		const instantiationService = new InstantiationService();
		try {
			return instantiationService.invokeFunction(command.handler, ...args) as T;
		} finally {
			instantiationService.dispose();
		}
	}

	$getCommands(): Promise<string[]> {
		return Promise.resolve([...CommandsRegistry.getCommands().keys()]);
	}

	dispose(): void {
		this.registrations.dispose();
	}
}

export class BunExtensionHostTestHarness {

	private readonly repoRoot = process.cwd();
	private readonly cjsFixturePath = join(this.repoRoot, 'extensions', 'vscode-test-bun-cjs');
	private readonly esmFixturePath = join(this.repoRoot, 'extensions', 'vscode-test-bun-esm');
	private readonly mixedFixturePath = join(this.repoRoot, 'extensions', 'vscode-test-bun-mixed');
	private readonly bunPath = process.env['CODE_TAURI_BUN'] || this.getBundledBunPath();

	private getBundledBunPath(): string {
		if (process.platform === 'darwin' && process.arch === 'arm64') {
			const bundled = join(this.repoRoot, 'src-tauri', 'binaries', 'vscode-bun-aarch64-apple-darwin');
			if (existsSync(bundled)) {
				return bundled;
			}
		}
		return 'bun';
	}

	async isAvailable(): Promise<boolean> {
		if (!existsSync(join(this.repoRoot, 'out', 'bootstrap-fork.js'))) {
			return false;
		}

		return new Promise<boolean>(resolve => {
			const child = spawn(this.bunPath, ['--version'], { stdio: 'ignore' });
			child.once('error', () => resolve(false));
			child.once('exit', code => resolve(code === 0));
		});
	}

	async run(): Promise<IBunExtensionHostFixtureRun> {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), 'vscode-bun-cjs-'));
		const socketPath = process.platform === 'win32'
			? `\\\\.\\pipe\\vscode-bun-cjs-${process.pid}-${Date.now()}`
			: join(temporaryDirectory, 'extension-host.sock');
		const bunCachePath = join(temporaryDirectory, 'bun-cache');
		const logsPath = join(temporaryDirectory, 'logs');
		await Promise.all([mkdir(bunCachePath), mkdir(logsPath)]);

		const fixtureFilesBefore = await this.listFixtureFiles();
		let host: IRunningHost | undefined;
		const disposables = new DisposableStore();
		let mainThreadCommands: BunFixtureMainThreadCommands | undefined;

		try {
			host = await this.startHost(socketPath, bunCachePath);
			const initData = this.createInitData(temporaryDirectory, logsPath);
			await waitForMessage(host.protocol, MessageType.Ready, 'ready');
			host.protocol.send(VSBuffer.fromString(JSON.stringify(initData)));
			await waitForMessage(host.protocol, MessageType.Initialized, 'initialized');

			const rpc = disposables.add(new RPCProtocol(host.protocol));
			const activatedExtensionIds = new Set<string>();
			const defaultActor = new Proxy({}, {
				get: (_target, property) => {
					if (property === 'dispose') {
						return () => undefined;
					}
					if (typeof property !== 'string' || !property.startsWith('$')) {
						return undefined;
					}
					return (...args: object[]) => {
						if (property === '$logExtensionHostMessage' || property === '$log') {
							host!.output.push(JSON.stringify(args));
						} else if (property === '$onDidActivateExtension') {
							const extensionIdentifier = args[0] as ExtensionIdentifier;
							activatedExtensionIds.add(extensionIdentifier.value);
						} else if (property === '$onExtensionActivationError') {
							host!.output.push(JSON.stringify({ property, args }).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g, '<vscode-api-module>'));
						} else if (property === '$asBrowserUri') {
							return args[0];
						}
						return undefined;
					};
				}
			}) as object;

			for (const identifier of Object.values(MainContext) as ProxyIdentifier<object>[]) {
				rpc.set(identifier, defaultActor);
			}

			const extHostContext: IExtHostContext = {
				remoteAuthority: null,
				extensionHostKind: ExtensionHostKind.LocalProcess,
				getProxy: identifier => rpc.getProxy(identifier),
				set: (identifier, instance) => rpc.set(identifier, instance),
				dispose: () => rpc.dispose(),
				assertRegistered: identifiers => rpc.assertRegistered(identifiers),
				drain: () => rpc.drain()
			};
			mainThreadCommands = new BunFixtureMainThreadCommands(extHostContext.getProxy(ExtHostContext.ExtHostCommands));
			rpc.set(MainContext.MainThreadCommands, mainThreadCommands);

			const emptyConfiguration = ConfigurationModel.createEmptyModel(new NullLogService());
			const configuration: IConfigurationInitData = {
				defaults: emptyConfiguration,
				policy: emptyConfiguration,
				application: emptyConfiguration,
				userLocal: emptyConfiguration,
				userRemote: emptyConfiguration,
				workspace: emptyConfiguration,
				folders: [],
				configurationScopes: []
			};
			await rpc.getProxy(ExtHostContext.ExtHostConfiguration).$initializeConfiguration(configuration);
			await rpc.getProxy(ExtHostContext.ExtHostWorkspace).$initializeWorkspace(null as IWorkspaceData | null, true);
			await rpc.getProxy(ExtHostContext.ExtHostExtensionService).$activateByEvent('*', ActivationKind.Normal);
			await rpc.getProxy(ExtHostContext.ExtHostExtensionService).$activateByEvent(`onCommand:${cjsCommandId}`, ActivationKind.Normal);
			await rpc.getProxy(ExtHostContext.ExtHostExtensionService).$activateByEvent(`onCommand:${mixedCommandId}`, ActivationKind.Normal);

			const cjsCommandRegistered = CommandsRegistry.getCommand(cjsCommandId) !== undefined;
			const esmCommandRegistered = CommandsRegistry.getCommand(esmCommandId) !== undefined;
			const mixedCommandRegistered = CommandsRegistry.getCommand(mixedCommandId) !== undefined;
			const cjsResult = await mainThreadCommands.$executeCommand<IBunCjsFixtureResult>(cjsCommandId, []);
			if (!cjsResult) {
				throw new Error(`Command '${cjsCommandId}' returned no fixture result.\n${host.output.join('')}`);
			}
			const esmResult = await mainThreadCommands.$executeCommand<IBunEsmFixtureResult>(esmCommandId, []);
			if (!esmResult) {
				throw new Error(`Command '${esmCommandId}' returned no fixture result.\n${host.output.join('')}`);
			}
			const mixedResult = await mainThreadCommands.$executeCommand<IBunMixedFixtureResult>(mixedCommandId, []);
			if (!mixedResult) {
				throw new Error(`Command '${mixedCommandId}' returned no fixture result.\n${host.output.join('')}`);
			}

			host.protocol.send(createMessageOfType(MessageType.Terminate));
			await waitForExit(host.child);
			const fixtureFilesAfter = await this.listFixtureFiles();
			const bunCacheFiles = await listFiles(bunCachePath);
			const output = host.output.join('\n');

			return {
				cjsResult,
				esmResult,
				mixedResult,
				activatedExtensionIds: [...activatedExtensionIds].sort(),
				cjsCommandRegistered,
				esmCommandRegistered,
				mixedCommandRegistered,
				cjsDeactivated: output.includes(cjsDeactivateSentinel),
				esmDeactivated: output.includes(esmDeactivateSentinel),
				mixedDeactivated: output.includes(mixedDeactivateSentinel),
				output,
				fixtureFilesBefore,
				fixtureFilesAfter,
				bunCacheFiles
			};
		} finally {
			mainThreadCommands?.dispose();
			disposables.dispose();
			host?.protocol.dispose();
			if (host?.child.exitCode === null) {
				host.child.kill();
			}
			await closeServer(host?.server);
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}

	private async startHost(socketPath: string, bunCachePath: string): Promise<IRunningHost> {
		const output: string[] = [];
		const server = createServer();
		await new Promise<void>((resolve, reject) => {
			server.listen(socketPath, resolve);
			server.once('error', reject);
		});

		const child = spawn(this.bunPath, [join(this.repoRoot, 'out', 'bootstrap-fork.js'), '--skipWorkspaceStorageLock'], {
			cwd: this.repoRoot,
			env: {
				...process.env,
				BUN_INSTALL_CACHE_DIR: bunCachePath,
				NODE_ENV: 'development',
				VSCODE_DEV: '1',
				VSCODE_ESM_ENTRYPOINT: 'vs/workbench/api/node/extensionHostProcess',
				VSCODE_HANDLES_UNCAUGHT_ERRORS: 'true',
				VSCODE_EXTHOST_IPC_HOOK: socketPath,
				VSCODE_PARENT_PID: process.pid.toString()
			}
		});
		child.stdout.setEncoding('utf8');
		child.stderr.setEncoding('utf8');
		child.stdout.on('data', data => output.push(data));
		child.stderr.on('data', data => output.push(data));
		child.once('error', error => output.push(error.stack || error.message));

		const socket = await waitForSocket(server, child, output);
		const protocol = new PersistentProtocol({ socket: new NodeSocket(socket, 'bun-extension-host-test') });
		protocol.sendResume();
		return { child, server, protocol, output };
	}

	private createInitData(temporaryDirectory: string, logsPath: string): IExtensionHostInitData {
		const cjsManifest = {
			name: 'vscode-bun-fixture-cjs',
			publisher: 'vscode-test',
			version: '0.0.1',
			engines: { vscode: '*' },
			main: './extension.js',
			activationEvents: [`onCommand:${cjsCommandId}`]
		} satisfies IExtensionManifest;
		const cjsExtension = this.createFixtureDescription(cjsManifest, cjsExtensionId, this.cjsFixturePath);
		const esmManifest = {
			name: 'vscode-bun-fixture-esm',
			displayName: 'Bun Fixture ESM',
			publisher: 'vscode-test',
			version: '0.0.1',
			type: 'module',
			engines: { vscode: '*' },
			main: './extension.js',
			activationEvents: ['*']
		} satisfies IExtensionManifest;
		const esmExtension = this.createFixtureDescription(esmManifest, esmExtensionId, this.esmFixturePath);
		const mixedManifest = {
			name: 'vscode-bun-fixture-mixed',
			displayName: 'Bun Fixture Mixed',
			publisher: 'vscode-test',
			version: '0.0.1',
			type: 'module',
			engines: { vscode: '*' },
			main: './extension.cjs',
			activationEvents: [`onCommand:${mixedCommandId}`]
		} satisfies IExtensionManifest;
		const mixedExtension = this.createFixtureDescription(mixedManifest, mixedExtensionId, this.mixedFixturePath);

		return {
			version: 'test',
			quality: undefined,
			parentPid: 0,
			environment: {
				isExtensionDevelopmentDebug: false,
				appName: 'VS Code Bun Extension Host Test',
				appHost: 'tauri-test',
				appRoot: URI.file(this.repoRoot),
				appLanguage: 'en',
				isExtensionTelemetryLoggingOnly: false,
				appUriScheme: 'code-tauri-test',
				globalStorageHome: URI.file(join(temporaryDirectory, 'global-storage')),
				workspaceStorageHome: URI.file(join(temporaryDirectory, 'workspace-storage')),
				skipWorkspaceStorageLock: true,
				isSessionsWindow: false
			},
			workspace: undefined,
			extensions: new ExtensionHostExtensions(0, [cjsExtension, esmExtension, mixedExtension], [cjsExtensionId, esmExtensionId, mixedExtensionId]).toSnapshot(),
			telemetryInfo: {
				sessionId: 'bun-fixtures',
				machineId: 'bun-fixtures',
				sqmId: 'bun-fixtures',
				devDeviceId: 'bun-fixtures',
				firstSessionDate: new Date(0).toISOString()
			},
			logLevel: LogLevel.Off,
			loggers: [],
			logsLocation: URI.file(logsPath),
			autoStart: true,
			remote: { isRemote: false, authority: undefined, connectionData: null },
			consoleForward: { includeStack: true, logNative: false },
			uiKind: UIKind.Desktop
		};
	}

	private createFixtureDescription(manifest: IExtensionManifest, identifier: ExtensionIdentifier, fixturePath: string): IExtensionDescription {
		return {
			...manifest,
			id: identifier.value,
			identifier,
			isBuiltin: false,
			isUserBuiltin: false,
			isUnderDevelopment: true,
			preRelease: false,
			extensionLocation: URI.file(fixturePath),
			targetPlatform: TargetPlatform.UNDEFINED
		};
	}

	private async listFixtureFiles(): Promise<string[]> {
		const [cjsFiles, esmFiles, mixedFiles] = await Promise.all([listFiles(this.cjsFixturePath), listFiles(this.esmFixturePath), listFiles(this.mixedFixturePath)]);
		return [
			...cjsFiles.map(path => `cjs/${path}`),
			...esmFiles.map(path => `esm/${path}`),
			...mixedFiles.map(path => `mixed/${path}`),
		].sort();
	}
}

async function waitForMessage(protocol: IMessagePassingProtocol, expected: MessageType, phase: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => {
			listener.dispose();
			reject(new Error(`Timed out waiting for the Extension Host ${phase} message.`));
		}, 10_000);
		const listener = protocol.onMessage(message => {
			if (isMessageOfType(message, expected)) {
				clearTimeout(timer);
				listener.dispose();
				resolve();
			}
		});
	});
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) {
		return;
	}
	await new Promise<void>((resolve, reject) => {
		const onExit = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			child.removeListener('exit', onExit);
			reject(new Error('Timed out waiting for the Bun Extension Host to exit.'));
		}, 10_000);
		child.once('exit', onExit);
	});
}

async function waitForSocket(server: Server, child: ChildProcessWithoutNullStreams, output: string[]): Promise<Socket> {
	return new Promise<Socket>((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			server.removeListener('connection', onConnection);
			server.removeListener('error', onError);
			child.removeListener('exit', onExit);
		};
		const onConnection = (socket: Socket) => {
			cleanup();
			resolve(socket);
		};
		const onError = (error: Error) => {
			cleanup();
			reject(error);
		};
		const onExit = () => {
			cleanup();
			reject(new Error(`Bun Extension Host exited before connecting.\n${output.join('')}`));
		};
		const timer = setTimeout(() => {
			cleanup();
			reject(new Error('Timed out waiting for the Bun Extension Host socket.'));
		}, 10_000);

		server.once('connection', onConnection);
		server.once('error', onError);
		child.once('exit', onExit);
	});
}

async function closeServer(server: Server | undefined): Promise<void> {
	if (!server?.listening) {
		return;
	}
	await new Promise<void>(resolve => server.close(() => resolve()));
}

async function listFiles(root: string): Promise<string[]> {
	if (!existsSync(root)) {
		return [];
	}
	const result: string[] = [];
	async function visit(directory: string, prefix: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				await visit(join(directory, entry.name), relativePath);
			} else {
				result.push(relativePath);
			}
		}
	}
	await visit(root, '');
	return result.sort();
}
