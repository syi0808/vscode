/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nodeModule from 'node:module';
import { IDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { realpathSync } from '../../../base/node/pfs.js';
import { RequireInterceptor } from '../common/extHostRequireInterceptor.js';

export class BunModuleRequireInterceptor extends RequireInterceptor implements IDisposable {

	dispose(): void { }

	protected _installInterceptor(): void {
		const that = this;
		const module = nodeModule;
		const applyAlternatives = (request: string) => {
			for (const alternativeModuleName of that._alternatives) {
				const alternative = alternativeModuleName(request);
				if (alternative) {
					request = alternative;
					break;
				}
			}
			return request;
		};

		// Bun does not route CommonJS requires through a replaced
		// `Module._load`, but it does call `Module.prototype.require`.
		const originalRequire = module.prototype.require;
		module.prototype.require = function bunRequire(this: { filename: string }, request: string) {
			request = applyAlternatives(request);
			if (!that._factories.has(request)) {
				return originalRequire.call(this, request);
			}

			return that._factories.get(request)!.load(
				request,
				URI.file(realpathSync(this.filename)),
				request => originalRequire.call(this, request)
			);
		};
	}
}
