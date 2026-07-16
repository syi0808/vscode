/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

declare module 'bun' {
	export interface BunPluginBuilder {
		onResolve(
			options: {
				filter: RegExp;
				namespace?: string;
			},
			callback: (args: {
				path: string;
				importer: string;
			}) => {
				path: string;
				namespace?: string;
			} | void
		): void;

		onLoad(
			options: {
				filter: RegExp;
				namespace?: string;
			},
			callback: (args: {
				path: string;
				namespace: string;
			}) => {
				loader?: 'js';
				contents?: string;
				exports?: Record<string, unknown>;
			} | void
		): void;
	}

	export interface BunPlugin {
		readonly name: string;
		setup(builder: BunPluginBuilder): void;
	}

	export function plugin(plugin: BunPlugin): void;
}
