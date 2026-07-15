/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface IInvokeOptions {
	readonly headers?: Record<string, string>;
}

interface ICodeTauriGlobal {
	invoke<T>(
		command: string,
		args?: Record<string, unknown>
	): Promise<T>;

	invokeRaw<T>(
		command: string,
		body: ArrayBuffer | Uint8Array,
		options?: IInvokeOptions
	): Promise<T>;
}


const bridge = (
	globalThis as typeof globalThis & {
		__CODE_TAURI__: ICodeTauriGlobal;
	}
).__CODE_TAURI__;


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
	body: ArrayBuffer | Uint8Array,
	options?: IInvokeOptions
): Promise<T> {
	return bridge.invokeRaw<T>(
		command,
		body,
		options
	);
}
