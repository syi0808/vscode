/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { IMessagePassingProtocol } from '../../../../base/parts/ipc/common/ipc.js';

export interface IExtensionHostRuntimeExit {
	readonly code: number | null;
	readonly signal: string | null;
}

export interface IExtensionHostRuntimeSession extends IDisposable {
	readonly pid: number | null;
	readonly protocol: IMessagePassingProtocol;
	readonly onExit: Event<IExtensionHostRuntimeExit>;

	terminate(): Promise<void>;
}

export interface IExtensionHostRuntime {
	start(): Promise<IExtensionHostRuntimeSession>;
}
