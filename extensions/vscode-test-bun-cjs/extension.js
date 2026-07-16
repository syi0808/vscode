/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

const vscode = require('vscode');
const nested = require('./nested');

const apiRegistryKey = Symbol.for('vscode-test.bun-api-registry');
let deactivated = false;

exports.activate = function activate(context) {
	const apiRegistry = globalThis[apiRegistryKey] ??= new Map();
	apiRegistry.set('cjs', vscode);

	context.subscriptions.push(
		vscode.commands.registerCommand('bunFixture.cjs', () => {
			const esmVscode = apiRegistry.get('esm');

			return {
				kind: 'cjs',
				nestedKind: nested.kind,
				hasWorkspaceApi: typeof vscode.workspace?.getConfiguration === 'function',
				extensionPath: context.extensionPath,
				deactivated,
				commandsDistinctFromEsm: vscode.commands !== esmVscode?.commands,
				workspaceDistinctFromEsm: vscode.workspace !== esmVscode?.workspace,
			};
		})
	);
};

exports.deactivate = function deactivate() {
	deactivated = true;
	process.stdout.write('[vscode-test-bun-cjs] deactivate\n');
};
