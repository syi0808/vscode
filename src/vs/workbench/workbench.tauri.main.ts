/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './workbench.web.main.js';

import type {
	IWorkbenchConstructionOptions,
	IWorkspace,
	IWorkspaceProvider
} from './browser/web.api.js';

import {
	TauriBrowserMain
} from './tauri-browser/tauri.main.js';

import type {
	INativeWindowConfiguration
} from '../platform/window/common/window.js';

import {
	isSingleFolderWorkspaceIdentifier,
	isWorkspaceIdentifier,
	reviveIdentifier
} from '../platform/workspace/common/workspace.js';


let browserMain:
	TauriBrowserMain | undefined;


function resolveWorkspace(
	configuration: INativeWindowConfiguration
): IWorkspace {

	const workspace =
		reviveIdentifier(
			configuration.workspace
		);

	if (
		isSingleFolderWorkspaceIdentifier(
			workspace
		)
	) {
		return {
			folderUri:
				workspace.uri
		};
	}

	if (
		isWorkspaceIdentifier(
			workspace
		)
	) {
		return {
			workspaceUri:
				workspace.configPath
		};
	}

	return undefined;
}


export async function main(
	configuration: INativeWindowConfiguration
): Promise<void> {

	const workspaceProvider:
		IWorkspaceProvider = {

		workspace:
			resolveWorkspace(
				configuration
			),

		trusted:
			true,

		async open(): Promise<boolean> {
			console.warn(
				'[code-tauri] ' +
				'workspace switching ' +
				'is not implemented yet'
			);

			return false;
		}
	};


	const browserConfiguration:
		IWorkbenchConstructionOptions = {

		workspaceProvider,

		enableWorkspaceTrust:
			false,

		productConfiguration: {
			...configuration.product,
			embedderIdentifier:
				'tauri'
		}
	};


	browserMain =
		new TauriBrowserMain(
			document.body,
			browserConfiguration
		);

	await browserMain.open();
}
