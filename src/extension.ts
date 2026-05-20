import * as vscode from 'vscode';
import { IntelliSearchViewProvider, openPanel, setPendingAutoBuild, runIncrementalUpdate } from './panelManager';
import { initEmbeddingWorker, IntelliSearchWorkerProvider } from './embeddingWorker';
import { IntelliSearchTool } from './searchTool';

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
	// Start the background embedding worker first so the WASM model begins
	// loading before the user opens the panel.
	initEmbeddingWorker(context);

	const provider = new IntelliSearchViewProvider(context);
	const workerProvider = new IntelliSearchWorkerProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			IntelliSearchViewProvider.viewType,
			provider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		vscode.window.registerWebviewViewProvider(
			IntelliSearchWorkerProvider.viewType,
			workerProvider,
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
		vscode.commands.registerCommand('intellisearch.openPanel', () =>
			openPanel(),
		),
		vscode.commands.registerCommand('intellisearch.buildIndex', () => {
			setPendingAutoBuild(true);
			openPanel();
		}),
		vscode.lm.registerTool('intellisearch_search', new IntelliSearchTool(context)),
	);

	// -------------------------------------------------------------------------
	// File watcher — keep the index incrementally up to date.
	// -------------------------------------------------------------------------
	const pendingChanged = new Set<string>();
	const pendingDeleted = new Set<string>();
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	const DEBOUNCE_MS = 3_000;

	function scheduleUpdate(): void {
		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceUri) { return; }
		if (debounceTimer) { clearTimeout(debounceTimer); }
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			const changed = [...pendingChanged].map(s => vscode.Uri.parse(s));
			const deleted = [...pendingDeleted].map(s => vscode.Uri.parse(s));
			pendingChanged.clear();
			pendingDeleted.clear();
			runIncrementalUpdate(workspaceUri, changed, deleted);
		}, DEBOUNCE_MS);
	}

	const watcher = vscode.workspace.createFileSystemWatcher('**/*');
	context.subscriptions.push(
		watcher,
		watcher.onDidChange(uri => {
			pendingChanged.add(uri.toString());
			scheduleUpdate();
		}),
		watcher.onDidCreate(uri => {
			pendingChanged.add(uri.toString());
			scheduleUpdate();
		}),
		watcher.onDidDelete(uri => {
			pendingDeleted.add(uri.toString());
			pendingChanged.delete(uri.toString());
			scheduleUpdate();
		}),
	);
}

export function deactivate(): void {}
