/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	Emitter,
	Event
} from '../../../base/common/event.js';

import {
	Disposable,
	toDisposable,
	type IDisposable
} from '../../../base/common/lifecycle.js';

import {
	isLinux,
	isMacintosh
} from '../../../base/common/platform.js';

import {
	URI
} from '../../../base/common/uri.js';

import {
	tauriInvoke,
	tauriInvokeRaw
} from '../../../base/parts/sandbox/tauri-browser/globals.js';

import {
	FileSystemProviderCapabilities,
	FileType,
	type IFileChange,
	type IFileDeleteOptions,
	type IFileOverwriteOptions,
	type IFileSystemProvider,
	type IFileWriteOptions,
	type IStat,
	type IWatchOptions
} from '../common/files.js';


interface ITauriStat {
	readonly entryType:
		| 'file'
		| 'directory'
		| 'symlink';

	readonly size: number;
	readonly mtime: number;
	readonly ctime: number;
}


interface ITauriEntry {
	readonly name: string;

	readonly entryType:
		| 'file'
		| 'directory'
		| 'symlink';
}


function toFileType(
	type: ITauriStat['entryType']
): FileType {
	switch (type) {
		case 'directory':
			return FileType.Directory;

		case 'symlink':
			return FileType.SymbolicLink;

		default:
			return FileType.File;
	}
}


export class TauriFileSystemProvider
	extends Disposable
	implements IFileSystemProvider {

	readonly capabilities =
		FileSystemProviderCapabilities.FileReadWrite
		| (
			isLinux || isMacintosh
				? FileSystemProviderCapabilities.PathCaseSensitive
				: 0
		);


	readonly onDidChangeCapabilities =
		Event.None;


	private readonly _onDidChangeFile =
		this._register(
			new Emitter<
				readonly IFileChange[]
			>()
		);

	readonly onDidChangeFile =
		this._onDidChangeFile.event;


	watch(
		_resource: URI,
		_opts: IWatchOptions
	): IDisposable {
		// Phase 5.1:
		// external filesystem watching is not implemented.
		return toDisposable(
			() => {}
		);
	}


	async stat(
		resource: URI
	): Promise<IStat> {
		const stat =
			await tauriInvoke<ITauriStat>(
				'fs_stat',
				{
					path:
						resource.fsPath
				}
			);

		return {
			type:
				toFileType(
					stat.entryType
				),

			ctime:
				stat.ctime,

			mtime:
				stat.mtime,

			size:
				stat.size
		};
	}


	async mkdir(
		resource: URI
	): Promise<void> {
		await tauriInvoke(
			'fs_mkdir',
			{
				path:
					resource.fsPath
			}
		);
	}


	async readdir(
		resource: URI
	): Promise<
		[string, FileType][]
	> {
		const entries =
			await tauriInvoke<
				ITauriEntry[]
			>(
				'fs_readdir',
				{
					path:
						resource.fsPath
				}
			);

		return entries.map(
			entry => [
				entry.name,
				toFileType(
					entry.entryType
				)
			]
		);
	}


	async delete(
		resource: URI,
		opts: IFileDeleteOptions
	): Promise<void> {
		await tauriInvoke(
			'fs_delete',
			{
				path:
					resource.fsPath,

				recursive:
					opts.recursive
			}
		);
	}


	async rename(
		from: URI,
		to: URI,
		opts: IFileOverwriteOptions
	): Promise<void> {
		await tauriInvoke(
			'fs_rename',
			{
				fromPath:
					from.fsPath,

				toPath:
					to.fsPath,

				overwrite:
					opts.overwrite
			}
		);
	}


	async readFile(
		resource: URI
	): Promise<Uint8Array> {
		const result =
			await tauriInvoke<
				ArrayBuffer | Uint8Array
			>(
				'fs_read_file',
				{
					path:
						resource.fsPath
				}
			);

		return result instanceof Uint8Array
			? result
			: new Uint8Array(result);
	}


	async writeFile(
		resource: URI,
		content: Uint8Array,
		opts: IFileWriteOptions
	): Promise<void> {
		await tauriInvokeRaw(
			'fs_write_file',
			content,
			{
				headers: {
					'x-code-tauri-path':
						encodeURIComponent(
							resource.fsPath
						),

					'x-code-tauri-create':
						String(
							opts.create
						),

					'x-code-tauri-overwrite':
						String(
							opts.overwrite
						)
				}
			}
		);
	}
}
