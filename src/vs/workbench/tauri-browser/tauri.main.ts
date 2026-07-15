/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	URI
} from '../../base/common/uri.js';

import {
	InMemoryFileSystemProvider
} from '../../platform/files/common/inMemoryFilesystemProvider.js';

import type {
	IFileService
} from '../../platform/files/common/files.js';

import {
	Schemas
} from '../../base/common/network.js';

import type {
	ILogService,
	ILoggerService
} from '../../platform/log/common/log.js';

import {
	tauriInvoke
} from '../../base/parts/sandbox/tauri-browser/globals.js';

import {
	TauriFileSystemProvider
} from '../../platform/files/tauri-browser/tauriFileSystemProvider.js';

import {
	BrowserMain
} from '../browser/web.main.js';

import type {
	IWorkbenchEnvironmentService
} from '../services/environment/common/environmentService.js';


interface IAppPaths {
	readonly dataDir:
		string;

	readonly cacheDir:
		string;

	readonly userDataDir:
		string;

	readonly logsDir:
		string;

	readonly extensionsDir:
		string;
}

// @ts-ignore
export class TauriBrowserMain
	extends BrowserMain {

	protected override async registerIndexedDBFileSystemProviders(
		_environmentService:
			IWorkbenchEnvironmentService,

		fileService:
			IFileService,

		_logService:
			ILogService,

		_loggerService:
			ILoggerService,

		logsPath:
			URI
	): Promise<void> {

		const paths =
			await tauriInvoke<
				IAppPaths
			>(
				'get_app_paths'
			);


		const logProvider =
			this._register(
				new TauriFileSystemProvider({
					root:
						paths.logsDir,

					scheme:
						logsPath.scheme
				})
			);

		this._register(
			fileService
				.registerProvider(
					logsPath.scheme,
					logProvider
				)
		);


		const userDataProvider =
			this._register(
				new TauriFileSystemProvider({
					root:
						paths.userDataDir,

					scheme:
						Schemas
							.vscodeUserData
				})
			);

		this._register(
			fileService
				.registerProvider(
					Schemas
						.vscodeUserData,

					userDataProvider
				)
		);


		this._register(
			fileService
				.registerProvider(
					Schemas.tmp,

					new InMemoryFileSystemProvider()
				)
		);


		const localFileProvider =
			this._register(
				new TauriFileSystemProvider()
			);

		this._register(
			fileService
				.registerProvider(
					Schemas.file,

					localFileProvider
				)
		);
	}
}
