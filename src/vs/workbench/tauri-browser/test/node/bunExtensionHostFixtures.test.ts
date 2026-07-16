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

	test('loads a CJS extension and completes the command RPC round trip', async function () {
		const harness = new BunExtensionHostTestHarness();
		if (!await harness.isAvailable()) {
			this.skip();
		}

		const run = await harness.run();
		assert.deepStrictEqual({
			result: run.result,
			extensionActivated: run.extensionActivated,
			commandRegistered: run.commandRegistered,
			deactivated: run.deactivated,
			fixtureUnchanged: run.fixtureFilesAfter,
			bunCacheFiles: run.bunCacheFiles,
			hasImporterWarning: /Could not identify extension for 'vscode'/.test(run.output),
			hasAutoInstallActivity: /auto[- ]install|Resolving packages|Installed\s+.*vscode|vscode@(?:npm:)?/i.test(run.output)
		}, {
			result: {
				kind: 'cjs',
				nestedKind: 'cjs-nested',
				hasWorkspaceApi: true,
				extensionPath: run.result.extensionPath,
				deactivated: false
			},
			extensionActivated: true,
			commandRegistered: true,
			deactivated: true,
			fixtureUnchanged: run.fixtureFilesBefore,
			bunCacheFiles: [],
			hasImporterWarning: false,
			hasAutoInstallActivity: false
		});
		assert.strictEqual(run.result.extensionPath.replaceAll('\\', '/').endsWith('/extensions/vscode-test-bun-cjs'), true);
	});
});
