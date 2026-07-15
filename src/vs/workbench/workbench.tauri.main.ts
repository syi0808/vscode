/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './workbench.web.main.js';

import { BrowserMain } from './browser/web.main.js';
import type {
	IWorkbenchConstructionOptions,
	IWorkspaceProvider
} from './browser/web.api.js';

import type {
	INativeWindowConfiguration
} from '../platform/window/common/window.js';


let browserMain: BrowserMain | undefined;


export async function main(
	configuration: INativeWindowConfiguration
): Promise<void> {

	const workspaceProvider: IWorkspaceProvider = {
		// Phase 4 intentionally starts empty.
		//
		// Phase 5 will restore configuration.workspace
		// after a real Tauri filesystem provider exists.
		workspace: undefined,

		trusted: true,

		async open(): Promise<boolean> {
			console.warn(
				'[code-tauri] workspace switching is not implemented yet'
			);

			return false;
		}
	};


	const browserConfiguration: IWorkbenchConstructionOptions = {
		workspaceProvider,

		enableWorkspaceTrust: false,

		productConfiguration: {
			...configuration.product,
			embedderIdentifier: 'tauri'
		}
	};


	browserMain = new BrowserMain(
		document.body,
		browserConfiguration
	);

	await browserMain.open();
}
