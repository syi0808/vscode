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
	TauriFileSystemProvider
} from '../../platform/files/tauri-browser/tauriFileSystemProvider.js';

import {
	BrowserMain
} from '../browser/web.main.js';

import type {
	IWorkbenchEnvironmentService
} from '../services/environment/common/environmentService.js';

// @ts-ignore
export class TauriBrowserMain extends BrowserMain {

	protected override async registerIndexedDBFileSystemProviders(
		_environmentService: IWorkbenchEnvironmentService,
		fileService: IFileService,
		_logService: ILogService,
		_loggerService: ILoggerService,
		logsPath: URI
	): Promise<void> {

		// Phase 5:
		// logs and user data are intentionally temporary.
		fileService.registerProvider(
			logsPath.scheme,
			new InMemoryFileSystemProvider()
		);

		fileService.registerProvider(
			Schemas.vscodeUserData,
			new InMemoryFileSystemProvider()
		);

		fileService.registerProvider(
			Schemas.tmp,
			new InMemoryFileSystemProvider()
		);


		const tauriFileSystem =
			this._register(
				new TauriFileSystemProvider()
			);

		this._register(
			fileService.registerProvider(
				Schemas.file,
				tauriFileSystem
			)
		);
	}

}
