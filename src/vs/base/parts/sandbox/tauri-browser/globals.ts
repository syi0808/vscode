/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface IInvokeOptions {
	readonly headers?: Record<string, string>;
}


export interface ITauriChannel<T> {
	readonly id: number;

	onmessage: (
		message: T
	) => void;

	toJSON(): string;

	dispose(): void;
}


interface ICodeTauriGlobal {
	invoke<T>(
		command: string,
		args?: Record<string, unknown>
	): Promise<T>;

	invokeRaw<T>(
		command: string,
		body:
			| ArrayBuffer
			| Uint8Array,
		options?: IInvokeOptions
	): Promise<T>;
}


interface ICodeTauriScope {
	readonly __CODE_TAURI__:
		ICodeTauriGlobal;

	readonly __CODE_TAURI_CREATE_CHANNEL__:
		<T>(
			onMessage:
				(message: T) => void
		) => ITauriChannel<T>;
}


const scope =
	globalThis as typeof globalThis
	& ICodeTauriScope;


const bridge =
	scope.__CODE_TAURI__;


export function tauriInvoke<T>(
	command: string,
	args?: Record<string, unknown>
): Promise<T> {
	return bridge.invoke<T>(
		command,
		args
	);
}


export function tauriInvokeRaw<T>(
	command: string,
	body:
		| ArrayBuffer
		| Uint8Array,
	options?: IInvokeOptions
): Promise<T> {
	return bridge.invokeRaw<T>(
		command,
		body,
		options
	);
}


export function tauriCreateChannel<T>(
	onMessage:
		(message: T) => void
): ITauriChannel<T> {
	return scope
		.__CODE_TAURI_CREATE_CHANNEL__(
			onMessage
		);
}
