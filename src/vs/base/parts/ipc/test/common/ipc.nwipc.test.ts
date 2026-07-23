/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { VSBuffer } from '../../../../common/buffer.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../test/common/utils.js';
import { INwipcNativePort, INwipcNativePortHandler, NwipcMessagePassingProtocol, NwipcSendDisposition } from '../../common/ipc.nwipc.js';

class TestPort implements INwipcNativePort {
	bufferedAmount = 0;
	handler: INwipcNativePortHandler | undefined;
	readonly sent: number[][] = [];
	closeCount = 0;
	backpressureAfterSend = false;
	failSend = false;

	send(payload: Uint8Array): NwipcSendDisposition {
		if (this.failSend) {
			throw new Error('send failed');
		}
		this.sent.push(Array.from(payload));
		if (this.backpressureAfterSend) {
			this.backpressureAfterSend = false;
			return 'backpressured';
		}
		return 'sent';
	}

	close(): void {
		this.closeCount++;
	}

	setHandler(handler: INwipcNativePortHandler | undefined): void {
		this.handler = handler;
	}
}

suite('NwipcMessagePassingProtocol', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	test('copies incoming and outgoing bytes', () => {
		const port = new TestPort();
		const protocol = disposables.add(new NwipcMessagePassingProtocol(port));
		const received: number[][] = [];
		disposables.add(protocol.onMessage(message => received.push(Array.from(message.buffer))));

		const outgoing = Uint8Array.from([1, 2, 3]);
		protocol.send(VSBuffer.wrap(outgoing));
		outgoing[0] = 9;
		const incoming = Uint8Array.from([4, 5, 6]);
		port.handler?.message(incoming);
		incoming[0] = 9;

		assert.deepStrictEqual({ sent: port.sent, received }, {
			sent: [[1, 2, 3]],
			received: [[4, 5, 6]]
		});
	});

	test('queues subsequent messages until writable', async () => {
		const port = new TestPort();
		const protocol = disposables.add(new NwipcMessagePassingProtocol(port));
		port.backpressureAfterSend = true;

		protocol.send(VSBuffer.fromString('first'));
		protocol.send(VSBuffer.fromString('second'));
		assert.strictEqual(port.sent.length, 1);

		const drained = protocol.drain();
		port.handler?.writable();
		await drained;

		assert.deepStrictEqual(port.sent.map(bytes => VSBuffer.wrap(Uint8Array.from(bytes)).toString()), ['first', 'second']);
	});

	test('close is terminal and idempotent', () => {
		const port = new TestPort();
		const protocol = new NwipcMessagePassingProtocol(port);

		protocol.dispose();
		protocol.dispose();
		protocol.send(VSBuffer.fromString('ignored'));

		assert.deepStrictEqual({ closeCount: port.closeCount, sent: port.sent, handler: port.handler }, {
			closeCount: 1,
			sent: [],
			handler: undefined
		});
	});

	test('native send failure closes the protocol', () => {
		const port = new TestPort();
		const protocol = disposables.add(new NwipcMessagePassingProtocol(port));
		let closeCount = 0;
		disposables.add(protocol.onDidClose(() => closeCount++));
		port.failSend = true;

		protocol.send(VSBuffer.fromString('failure'));
		protocol.send(VSBuffer.fromString('ignored'));

		assert.deepStrictEqual({ closeCount, sent: port.sent, handler: port.handler }, {
			closeCount: 1,
			sent: [],
			handler: undefined
		});
	});
});
