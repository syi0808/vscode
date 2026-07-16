/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-new-javascript-files */

import * as vscode from 'vscode';

const apiRegistryKey = Symbol.for('vscode-test.bun-api-registry');

function getApiRegistry() {
	return globalThis[apiRegistryKey] ??= new Map();
}

export function activate(context) {
	getApiRegistry().set('esm', vscode);

	context.subscriptions.push(
		vscode.commands.registerCommand('bunFixture.esm', async () => {
			const dynamicallyImported = await import('vscode');

			return {
				kind: 'esm',
				staticDynamicMatch: vscode.commands === dynamicallyImported.commands,
			};
		})
	);
}

export function deactivate() {
	process.stdout.write('[vscode-test-bun-esm] deactivate\n');
}
