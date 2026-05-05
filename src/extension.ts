import * as vscode from 'vscode';
import { openPanel, setPendingAutoBuild } from './panelManager';
import { IntelliSearchTool } from './searchTool';

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('intellisearch.openPanel', () =>
			openPanel(context),
		),
		vscode.commands.registerCommand('intellisearch.buildIndex', () => {
			setPendingAutoBuild(true);
			openPanel(context);
		}),
		vscode.lm.registerTool('intellisearch_search', new IntelliSearchTool(context)),
	);

	openPanel(context);
}

export function deactivate(): void {}
