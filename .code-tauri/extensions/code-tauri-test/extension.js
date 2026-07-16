const vscode = require('vscode');
const fs = require('node:fs');

const logPath = '/tmp/code-tauri-extension.log';

function log(message) {
	fs.appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

exports.activate = function activate(context) {
	log(`activate bun=${process.versions.bun} node=${process.versions.node}`);
	console.log('[code-tauri-test] activated', {
		bun: process.versions.bun,
		node: process.versions.node,
		execPath: process.execPath
	});

	context.subscriptions.push(
		vscode.commands.registerCommand('codeTauri.test', async () => {
			log('command codeTauri.test invoked');
			await vscode.window.showInformationMessage(`Running on Bun ${process.versions.bun}`);
			log('showInformationMessage resolved');
		})
	);
};

exports.deactivate = function deactivate() {
	log('deactivate');
	console.log('[code-tauri-test] deactivated');
};
