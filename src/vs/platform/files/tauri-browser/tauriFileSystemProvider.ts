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
	isWindows
} from '../../../base/common/platform.js';

import {
	URI
} from '../../../base/common/uri.js';

import {
	tauriCreateChannel,
	tauriInvoke,
	tauriInvokeRaw
} from '../../../base/parts/sandbox/tauri-browser/globals.js';

import {
	FileChangeType,
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


interface IFsWatchChange {
	readonly kind:
		| 'added'
		| 'updated'
		| 'deleted';

	readonly path: string;
}


type IFsWatchMessage =
	| {
		readonly type:
			'changes';

		readonly changes:
			IFsWatchChange[];
	}
	| {
		readonly type:
			'error';

		readonly message:
			string;
	};


export interface ITauriFileSystemProviderOptions {
	/**
	 * When provided, URI paths are mapped under
	 * this directory.
	 *
	 * Example:
	 *
	 * vscode-userdata:/User/settings.json
	 *
	 * ->
	 *
	 * /app-data/userdata/User/settings.json
	 */
	readonly root?: string;

	/**
	 * Required together with root so watcher
	 * paths can be mapped back to a URI.
	 */
	readonly scheme?: string;
}


function toFileType(
	type:
		ITauriStat['entryType']
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


function toChangeType(
	kind:
		IFsWatchChange['kind']
): FileChangeType {
	switch (kind) {
		case 'added':
			return FileChangeType.ADDED;

		case 'deleted':
			return FileChangeType.DELETED;

		default:
			return FileChangeType.UPDATED;
	}
}


export class TauriFileSystemProvider
	extends Disposable
	implements IFileSystemProvider {

	readonly capabilities =
		FileSystemProviderCapabilities
			.FileReadWrite
		| (
			isLinux
				? FileSystemProviderCapabilities
					.PathCaseSensitive
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


	private readonly _onDidWatchError =
		this._register(
			new Emitter<string>()
		);

	readonly onDidWatchError =
		this._onDidWatchError.event;


	constructor(
		private readonly options:
			ITauriFileSystemProviderOptions
			= {}
	) {
		super();

		if (
			Boolean(options.root)
			!== Boolean(options.scheme)
		) {
			throw new Error(
				'root and scheme must be ' +
				'provided together'
			);
		}
	}


	private toFsPath(
		resource: URI
	): string {

		if (!this.options.root) {
			return resource.fsPath;
		}

		const segments =
			resource.path
				.split('/')
				.filter(Boolean);

		if (
			segments.some(
				segment =>
					segment === '..'
			)
		) {
			throw new Error(
				`Path escapes provider root: ${resource}`
			);
		}

		const separator =
			isWindows
				? '\\'
				: '/';

		const root =
			this.options.root
				.replace(
					/[\\/]+$/,
					''
				);

		if (
			segments.length === 0
		) {
			return root;
		}

		return [
			root,
			...segments
		].join(separator);
	}


	private fromFsPath(
		path: string
	): URI | undefined {

		if (
			!this.options.root
			|| !this.options.scheme
		) {
			return URI.file(path);
		}

		const normalize =
			(value: string) =>
				value
					.replace(
						/\\/g,
						'/'
					)
					.replace(
						/\/+$/,
						''
					);

		const root =
			normalize(
				this.options.root
			);

		const normalizedPath =
			normalize(
				path
			);

		if (
			normalizedPath !== root
			&& !normalizedPath
				.startsWith(
					`${root}/`
				)
		) {
			return undefined;
		}

		const relative =
			normalizedPath === root
				? ''
				: normalizedPath
					.slice(
						root.length + 1
					);

		return URI.from({
			scheme:
				this.options.scheme,

			path:
				`/${relative}`
		});
	}


	watch(
		resource: URI,
		opts: IWatchOptions
	): IDisposable {

		let disposed =
			false;

		let watchId:
			number
			| undefined;


		const channel =
			tauriCreateChannel<
				IFsWatchMessage
			>(
				message => {
					if (disposed) {
						return;
					}

					if (
						message.type
						=== 'error'
					) {
						this._onDidWatchError
							.fire(
								message.message
							);

						return;
					}

					const changes:
						IFileChange[] = [];

					for (
						const change
						of message.changes
					) {
						const changedResource =
							this.fromFsPath(
								change.path
							);

						if (
							!changedResource
						) {
							continue;
						}

						changes.push({
							resource:
								changedResource,

							type:
								toChangeType(
									change.kind
								)
						});
					}

					if (
						changes.length > 0
					) {
						this._onDidChangeFile
							.fire(
								changes
							);
					}
				}
			);


		void tauriInvoke<number>(
			'fs_watch_start',
			{
				path:
					this.toFsPath(
						resource
					),

				recursive:
					opts.recursive,

				excludes:
					opts.excludes,

				onEvent:
					channel
			}
		).then(
			id => {
				if (disposed) {
					void tauriInvoke(
						'fs_watch_stop',
						{
							watchId:
								id
						}
					);

					return;
				}

				watchId =
					id;
			},
			error => {
				this._onDidWatchError
					.fire(
						String(error)
					);
			}
		);


		return toDisposable(
			() => {
				disposed =
					true;

				channel.dispose();

				if (
					watchId
					!== undefined
				) {
					void tauriInvoke(
						'fs_watch_stop',
						{
							watchId
						}
					);
				}
			}
		);
	}


	async stat(
		resource: URI
	): Promise<IStat> {
		const stat =
			await tauriInvoke<
				ITauriStat
			>(
				'fs_stat',
				{
					path:
						this.toFsPath(
							resource
						)
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
					this.toFsPath(
						resource
					)
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
						this.toFsPath(
							resource
						)
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
					this.toFsPath(
						resource
					),

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
					this.toFsPath(
						from
					),

				toPath:
					this.toFsPath(
						to
					),

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
				ArrayBuffer
				| Uint8Array
			>(
				'fs_read_file',
				{
					path:
						this.toFsPath(
							resource
						)
				}
			);

		return result
			instanceof Uint8Array
				? result
				: new Uint8Array(
					result
				);
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
							this.toFsPath(
								resource
							)
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
