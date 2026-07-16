/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import nodeModule from 'node:module';
import { DisposableStore, IDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { URI } from '../../../base/common/uri.js';
import { realpathSync } from '../../../base/node/pfs.js';
import { RequireInterceptor } from '../common/extHostRequireInterceptor.js';

export class BunModuleRequireInterceptor extends RequireInterceptor implements IDisposable {

	private static _esmHooksInstalled = false;
	private static readonly _vscodeImportFnName = '_VSCODE_BUN_IMPORT_VSCODE_API';

	private readonly _store = new DisposableStore();

	dispose(): void {
		this._store.dispose();
	}

	override async install(): Promise<void> {
		await super.install();
		this._installEsmHooks();
	}

	protected _installInterceptor(): void {
		this._installCommonJsInterceptor();
	}

	private _installCommonJsInterceptor(): void {
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

	private _installEsmHooks(): void {
		if (BunModuleRequireInterceptor._esmHooksInstalled) {
			throw new Error('Bun vscode ESM hooks have already been installed');
		}

		if (typeof nodeModule.registerHooks !== 'function') {
			throw new Error('This Bun build does not support node:module.registerHooks');
		}
		BunModuleRequireInterceptor._esmHooksInstalled = true;

		const apiToKey = new WeakMap<object, string>();
		const apiByKey = new Map<string, Record<string, unknown>>();
		const apiImportDataUrl = new Map<string, string>();
		let keyCounter = 0;

		const getVscodeFactory = () => {
			const factory = this._factories.get('vscode');
			if (!factory) {
				throw new Error('The vscode API module factory is not registered');
			}
			return factory;
		};

		Object.defineProperty(globalThis, BunModuleRequireInterceptor._vscodeImportFnName, {
			enumerable: false,
			configurable: false,
			writable: false,
			value: (key: string) => apiByKey.get(key)
		});

		const hooks = nodeModule.registerHooks({
			resolve: (specifier, context, nextResolve) => {
				if (specifier !== 'vscode' || !context.parentURL) {
					return nextResolve(specifier, context);
				}

				const api = getVscodeFactory().load(
					'vscode',
					URI.parse(context.parentURL),
					() => { throw new Error('Original vscode module must not be loaded'); }
				) as Record<string, unknown>;

				let key = apiToKey.get(api);
				if (!key) {
					key = `api-${++keyCounter}`;
					apiToKey.set(api, key);
					apiByKey.set(key, api);
				}

				let url = apiImportDataUrl.get(key);
				if (!url) {
					const source = `const api = globalThis.${BunModuleRequireInterceptor._vscodeImportFnName}('${key}');\n${Object.keys(api).map(name => `export const ${name} = api['${name}'];`).join('\n')}`;
					url = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
					apiImportDataUrl.set(key, url);
				}

				return { url, shortCircuit: true };
			}
		});
		this._store.add(toDisposable(() => hooks.deregister()));
	}
}
