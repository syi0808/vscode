/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* eslint-disable local/code-no-new-javascript-files */

const cjsVscode = require('vscode');

const apiRegistryKey = Symbol.for('vscode-test.bun-api-registry');

exports.activate = async function activate(context) {
	const helper = await import('./esm-helper.mjs');
	const apiRegistry = globalThis[apiRegistryKey] ??= new Map();
	apiRegistry.set('mixed', cjsVscode);

	context.subscriptions.push(
		cjsVscode.commands.registerCommand('bunFixture.mixed', async () => {
			const cjsExtensionApi = apiRegistry.get('cjs');
			const esmExtensionApi = apiRegistry.get('esm');
			const esmCommandResult = await cjsVscode.commands.executeCommand('bunFixture.esm');

			return {
				kind: 'mixed',
				commandsIdentity: cjsVscode.commands === helper.esmVscode.commands,
				workspaceIdentity: cjsVscode.workspace === helper.esmVscode.workspace,
				commandsDistinctFromOtherExtensions:
					cjsVscode.commands !== cjsExtensionApi?.commands &&
					cjsVscode.commands !== esmExtensionApi?.commands,
				workspaceDistinctFromOtherExtensions:
					cjsVscode.workspace !== cjsExtensionApi?.workspace &&
					cjsVscode.workspace !== esmExtensionApi?.workspace,
				esmCommandResult,
			};
		})
	);
};

exports.deactivate = function deactivate() {
	process.stdout.write('[vscode-test-bun-mixed] deactivate\n');
};
