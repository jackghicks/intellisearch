import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
	console.log('intellisearch is now active in the web extension host!');

	const disposable = vscode.commands.registerCommand('intellisearch.helloWorld', () => {
		vscode.window.showInformationMessage('Hello World from IntelliSearch!');
	});

	context.subscriptions.push(disposable);
}

export function deactivate() {}
