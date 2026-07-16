/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { BunExtensionHostTestHarness } from './bunExtensionHostTestHarness.js';

suite('Bun Extension Host fixtures', function () {
	this.timeout(60_000);
	ensureNoDisposablesAreLeakedInTestSuite();

	test('loads CJS, ESM, and mixed extensions with isolated APIs and shared command RPC', async function () {
		const harness = new BunExtensionHostTestHarness();
		if (!await harness.isAvailable()) {
			this.skip();
		}

		const run = await harness.run();
		assert.deepStrictEqual({
			cjsResult: run.cjsResult,
			esmResult: run.esmResult,
			mixedResult: run.mixedResult,
			activatedExtensionIds: run.activatedExtensionIds,
			cjsCommandRegistered: run.cjsCommandRegistered,
			esmCommandRegistered: run.esmCommandRegistered,
			mixedCommandRegistered: run.mixedCommandRegistered,
			cjsDeactivated: run.cjsDeactivated,
			esmDeactivated: run.esmDeactivated,
			mixedDeactivated: run.mixedDeactivated,
			fixtureUnchanged: run.fixtureFilesAfter,
			bunCacheFiles: run.bunCacheFiles,
			hasImporterWarning: /Could not identify extension for 'vscode'/.test(run.output),
			hasAutoInstallActivity: /auto[- ]install|Resolving packages|Installed\s+.*vscode|vscode@(?:npm:)?/i.test(run.output)
		}, {
			cjsResult: {
				kind: 'cjs',
				nestedKind: 'cjs-nested',
				hasWorkspaceApi: true,
				extensionPath: run.cjsResult.extensionPath,
				deactivated: false,
				commandsDistinctFromEsm: true,
				workspaceDistinctFromEsm: true
			},
			esmResult: {
				kind: 'esm',
				staticDynamicMatch: true
			},
			mixedResult: {
				kind: 'mixed',
				commandsIdentity: true,
				workspaceIdentity: true,
				commandsDistinctFromOtherExtensions: true,
				workspaceDistinctFromOtherExtensions: true,
				esmCommandResult: {
					kind: 'esm',
					staticDynamicMatch: true
				}
			},
			activatedExtensionIds: [
				'vscode-test.vscode-bun-fixture-cjs',
				'vscode-test.vscode-bun-fixture-esm',
				'vscode-test.vscode-bun-fixture-mixed'
			],
			cjsCommandRegistered: true,
			esmCommandRegistered: true,
			mixedCommandRegistered: true,
			cjsDeactivated: true,
			esmDeactivated: true,
			mixedDeactivated: true,
			fixtureUnchanged: run.fixtureFilesBefore,
			bunCacheFiles: [],
			hasImporterWarning: false,
			hasAutoInstallActivity: false
		});
		assert.strictEqual(run.cjsResult.extensionPath.replaceAll('\\', '/').endsWith('/extensions/vscode-test-bun-cjs'), true);
	});
});
