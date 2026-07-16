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

	test('loads CJS and ESM extensions and completes command RPC round trips', async function () {
		const harness = new BunExtensionHostTestHarness();
		if (!await harness.isAvailable()) {
			this.skip();
		}

		const run = await harness.run();
		assert.deepStrictEqual({
			cjsResult: run.cjsResult,
			esmResult: run.esmResult,
			activatedExtensionIds: run.activatedExtensionIds,
			cjsCommandRegistered: run.cjsCommandRegistered,
			esmCommandRegistered: run.esmCommandRegistered,
			cjsDeactivated: run.cjsDeactivated,
			esmDeactivated: run.esmDeactivated,
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
				deactivated: false
			},
			esmResult: {
				fixture: 'esm',
				loader: 'esm',
				namedImportIdentity: true,
				dynamicImportIdentity: true
			},
			activatedExtensionIds: [
				'vscode-test.vscode-bun-fixture-cjs',
				'vscode-test.vscode-bun-fixture-esm'
			],
			cjsCommandRegistered: true,
			esmCommandRegistered: true,
			cjsDeactivated: true,
			esmDeactivated: true,
			fixtureUnchanged: run.fixtureFilesBefore,
			bunCacheFiles: [],
			hasImporterWarning: false,
			hasAutoInstallActivity: false
		});
		assert.strictEqual(run.cjsResult.extensionPath.replaceAll('\\', '/').endsWith('/extensions/vscode-test-bun-cjs'), true);
	});
});
