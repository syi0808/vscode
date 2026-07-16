/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const vscode = require('vscode');
const nested = require('./nested');

let deactivated = false;

exports.activate = function activate(context) {
	context.subscriptions.push(
		vscode.commands.registerCommand('bunFixture.cjs', () => ({
			kind: 'cjs',
			nestedKind: nested.kind,
			hasWorkspaceApi: typeof vscode.workspace?.getConfiguration === 'function',
			extensionPath: context.extensionPath,
			deactivated,
		}))
	);
};

exports.deactivate = function deactivate() {
	deactivated = true;
	process.stdout.write('[vscode-test-bun-cjs] deactivate\n');
};
