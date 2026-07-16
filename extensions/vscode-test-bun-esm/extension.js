/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { commands } from 'vscode';

export async function activate(context) {
	const dynamicallyImported = await import('vscode');

	if (commands !== vscode.commands) {
		throw new Error('Named ESM import identity mismatch');
	}

	if (dynamicallyImported.commands !== vscode.commands) {
		throw new Error('Dynamic ESM import identity mismatch');
	}

	context.subscriptions.push(
		vscode.commands.registerCommand('bunFixture.esm.report', () => ({
			fixture: 'esm',
			loader: 'esm',
			namedImportIdentity: commands === vscode.commands,
			dynamicImportIdentity: dynamicallyImported.commands === vscode.commands,
		}))
	);

	console.log('BUN_EXT_FIXTURE_RESULT', JSON.stringify({
		fixture: 'esm',
		phase: 'activated',
		namedImportIdentity: true,
		dynamicImportIdentity: true,
	}));
}

export function deactivate() {
	console.log('BUN_EXT_FIXTURE_RESULT', JSON.stringify({
		fixture: 'esm',
		phase: 'deactivated',
	}));
	process.stdout.write('[vscode-test-bun-esm] deactivate\n');
}
