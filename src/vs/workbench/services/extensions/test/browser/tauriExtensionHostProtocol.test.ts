/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TauriExtensionHostProtocol } from '../../tauri-browser/extensionHostProtocol.js';
import { IExtensionHostConnectedEvent, IExtensionHostMessageEvent } from '../../tauri-browser/extensionHostStarter.js';

suite('TauriExtensionHostProtocol', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('filters resource events and preserves message chunks', () => {
		const messages = disposables.add(new Emitter<IExtensionHostMessageEvent>());
		const connected = disposables.add(new Emitter<IExtensionHostConnectedEvent>());
		const protocol = disposables.add(new TauriExtensionHostProtocol('expected', {
			onMessageEvent: messages.event,
			onConnectedEvent: connected.event
		}));
		const received: number[][] = [];
		let connectionCount = 0;
		disposables.add(protocol.onMessage(message => received.push(Array.from(message.buffer))));
		disposables.add(protocol.onDidConnect(() => connectionCount++));

		messages.fire({ id: 'other', data: [9] });
		connected.fire({ id: 'other' });
		messages.fire({ id: 'expected', data: [0, 1, 255] });
		messages.fire({ id: 'expected', data: [2, 3] });
		connected.fire({ id: 'expected' });

		assert.deepStrictEqual({ received, connectionCount }, {
			received: [[0, 1, 255], [2, 3]],
			connectionCount: 1
		});
	});

	test('sends the exact byte sequence and ignores events after dispose', async () => {
		const messages = disposables.add(new Emitter<IExtensionHostMessageEvent>());
		const connected = disposables.add(new Emitter<IExtensionHostConnectedEvent>());
		const sent: { id: string; data: number[] }[] = [];
		let sendInProgress = false;
		let sentConcurrently = false;
		const protocol = new TauriExtensionHostProtocol('resource', {
			onMessageEvent: messages.event,
			onConnectedEvent: connected.event
		}, async (id, data) => {
			sentConcurrently ||= sendInProgress;
			sendInProgress = true;
			await Promise.resolve();
			sent.push({ id, data });
			sendInProgress = false;
		});
		let messageCount = 0;
		const messageListener = protocol.onMessage(() => messageCount++);

		protocol.send(VSBuffer.wrap(Uint8Array.from([255, 0, 127])));
		protocol.send(VSBuffer.wrap(Uint8Array.from([1, 2, 3])));
		await protocol.drain();
		protocol.dispose();
		messages.fire({ id: 'resource', data: [1] });
		messageListener.dispose();

		assert.deepStrictEqual({ sent, sentConcurrently, messageCount }, {
			sent: [
				{ id: 'resource', data: [255, 0, 127] },
				{ id: 'resource', data: [1, 2, 3] }
			],
			sentConcurrently: false,
			messageCount: 0
		});
	});
});
