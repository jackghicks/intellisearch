import * as vscode from 'vscode';
import { chunkFile, isIndexable, RawChunk } from './chunker';
import { saveIndex, loadIndex, indexExists } from './indexStore';
import { Chunk, IndexData, MetaJson } from './types';
import { MODEL_NAME, VECTOR_DIM, ALWAYS_EXCLUDE } from './utils';
import { embedBatch, embedQuery } from './embeddingWorker';
import panelHtml from './webview/panel.html';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;

/** Deferred flag: true when `intellisearch.buildIndex` was called before the webview initialised. */
let pendingAutoBuild = false;

/** Index held in extension-host memory for fast search. */
let inMemoryIndex: { data: IndexData; vectors: Float32Array } | null = null;

// ---------------------------------------------------------------------------
// Panel management
// ---------------------------------------------------------------------------
export async function openPanel(context: vscode.ExtensionContext): Promise<void> {
	if (panel) {
		panel.reveal(vscode.ViewColumn.Two);
		if (pendingAutoBuild) {
			pendingAutoBuild = false;
			panel.webview.postMessage({ type: 'triggerBuild' });
		}
		return;
	}

	panel = vscode.window.createWebviewPanel(
		'intellisearch.panel',
		'IntelliSearch',
		vscode.ViewColumn.Two,
		{ enableScripts: true, retainContextWhenHidden: true },
	);

	panel.webview.html = panelHtml;

	panel.webview.onDidReceiveMessage(
		(msg) => handleMessage(msg, context),
		undefined,
		context.subscriptions,
	);

	panel.onDidDispose(
		() => {
			panel = undefined;
		},
		null,
		context.subscriptions,
	);
}

export function setPendingAutoBuild(value: boolean): void {
	pendingAutoBuild = value;
}

// ---------------------------------------------------------------------------
// Message handler  (extension ← webview)
// ---------------------------------------------------------------------------
async function handleMessage(
	msg: Record<string, unknown>,
	_context: vscode.ExtensionContext,
): Promise<void> {
	const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;

	if (!workspaceUri) {
		panel?.webview.postMessage({ type: 'error', message: 'No workspace folder is open.' });
		return;
	}

	switch (msg.type) {

		// Webview finished loading ------------------------------------------------
		case 'webviewReady': {
			const hasIndex = await indexExists(workspaceUri);
			const autoBuild = pendingAutoBuild && !hasIndex;
			pendingAutoBuild = false;

			panel?.webview.postMessage({ type: 'init', hasIndex, autoBuild });

			if (hasIndex) {
				await sendIndexToWebview(workspaceUri);
			}
			break;
		}

		// User clicked "Build Index" / "Rebuild Index" ----------------------------
		case 'buildIndex':
			console.log('[intellisearch] buildIndex message received');
			await runBuildIndex(workspaceUri);
			break;

		// Open a file at a given line range in the editor -------------------------
		case 'openFile': {
			const fileUri = vscode.Uri.joinPath(workspaceUri, msg.file as string);
			const opts: vscode.TextDocumentShowOptions = {
				preview: true,
				selection: new vscode.Range(msg.start as number, 0, msg.end as number, 0),
			};
			await vscode.commands.executeCommand('vscode.open', fileUri, opts);
			break;
		}

		// UI panel search query — embed via worker, search in extension host ------
		case 'searchQuery': {
			const query = msg.query as string;
			if (!inMemoryIndex) {
				panel?.webview.postMessage({ type: 'searchError', message: 'No index loaded.' });
				return;
			}
			let queryVector: Float32Array;
			try {
				queryVector = await embedQuery(query);
			} catch (err) {
				panel?.webview.postMessage({
					type: 'searchError',
					message: (err as Error).message,
				});
				return;
			}
			const results = cosineSearch(inMemoryIndex, queryVector, 10);
			panel?.webview.postMessage({ type: 'searchResults', results });
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Indexing orchestration
// ---------------------------------------------------------------------------
async function runBuildIndex(workspaceUri: vscode.Uri): Promise<void> {
	console.log('[intellisearch] runBuildIndex start');
	const files = await vscode.workspace.findFiles('**/*', ALWAYS_EXCLUDE);
	const indexable = files.filter(isIndexable);
	console.log(`[intellisearch] findFiles done — total=${files.length}, indexable=${indexable.length}`);

	panel?.webview.postMessage({ type: 'chunkStart', total: indexable.length });

	const rawChunks: RawChunk[] = [];

	for (let i = 0; i < indexable.length; i++) {
		const uri = indexable[i];
		panel?.webview.postMessage({
			type: 'chunkProgress',
			done: i + 1,
			total: indexable.length,
			file: uri.path.split('/').pop() ?? '',
		});
		try {
			const chunks = await chunkFile(uri, workspaceUri.path);
			console.log(`[intellisearch]   → ${chunks.length} chunk(s) from ${uri.path.split('/').pop()}`);
			rawChunks.push(...chunks);
		} catch (err) {
			console.warn('[intellisearch] skip', uri.path, err);
		}
	}

	if (rawChunks.length === 0) {
		panel?.webview.postMessage({
			type: 'error',
			message: 'No indexable content found in the workspace.',
		});
		return;
	}

	console.log(`[intellisearch] chunking complete — ${rawChunks.length} raw chunks total`);

	// Embed via the background worker (WASM lives there, not in the UI panel).
	let vectors: Float32Array;
	try {
		vectors = await embedBatch(
			rawChunks.map(rc => ({ text: rc.text, file: rc.file })),
			(done, total, file) => {
				panel?.webview.postMessage({ type: 'embedProgress', done, total, file });
			},
		);
	} catch (err) {
		console.error('[intellisearch] embedBatch failed:', err);
		panel?.webview.postMessage({
			type: 'error',
			message: `Embedding failed: ${(err as Error).message}`,
		});
		return;
	}

	const chunks: Chunk[] = rawChunks.map((rc, i) => ({
		id: i,
		file: rc.file,
		range: rc.range,
		tokenCount: rc.tokenCount,
		preview: rc.preview,
		symbolName: rc.symbolName,
		vectorOffset: i * VECTOR_DIM,
	}));

	const fileMeta: IndexData['files'] = {};
	for (const rc of rawChunks) {
		const fm = fileMeta[rc.file] ?? { mtime: 0, chunkCount: 0 };
		fm.chunkCount += 1;
		fileMeta[rc.file] = fm;
	}

	const meta: MetaJson = {
		version: 1,
		model: MODEL_NAME,
		created: Date.now(),
		chunkCount: chunks.length,
		vectorDim: VECTOR_DIM,
	};

	const indexData: IndexData = { meta, chunks, files: fileMeta };

	panel?.webview.postMessage({ type: 'savingIndex' });
	console.log(`[intellisearch] saving index — ${chunks.length} chunks`);
	await saveIndex(workspaceUri, indexData, vectors);
	inMemoryIndex = { data: indexData, vectors };
	console.log('[intellisearch] index saved to disk');

	panel?.webview.postMessage({ type: 'indexSaved', meta });
}

async function sendIndexToWebview(workspaceUri: vscode.Uri): Promise<void> {
	console.log('[intellisearch] loading existing index from disk…');
	const loaded = await loadIndex(workspaceUri);
	if (!loaded) { console.warn('[intellisearch] loadIndex returned null'); return; }
	inMemoryIndex = loaded;
	console.log(`[intellisearch] index loaded — ${loaded.data.chunks.length} chunks`);
	panel?.webview.postMessage({
		type:       'loadIndex',
		chunkCount: loaded.data.chunks.length,
		meta:       loaded.data.meta,
	});
}

// ---------------------------------------------------------------------------
// Search helpers
// ---------------------------------------------------------------------------
function cosineSearch(
	index: { data: IndexData; vectors: Float32Array },
	queryVec: Float32Array,
	topK: number,
): Array<{ chunk: Chunk; score: number }> {
	const { data: { chunks }, vectors } = index;
	const scored = chunks.map(chunk => {
		const vec = vectors.subarray(chunk.vectorOffset, chunk.vectorOffset + VECTOR_DIM);
		let s = 0;
		for (let i = 0; i < vec.length; i++) { s += queryVec[i] * vec[i]; }
		return { chunk, score: s };
	});
	scored.sort((a, b) => b.score - a.score);
	return scored.slice(0, topK);
}

// ---------------------------------------------------------------------------
// Embed-query bridge — used by the LM tool (searchTool.ts)
// ---------------------------------------------------------------------------
export { embedQuery as embedQueryViaWebview };
