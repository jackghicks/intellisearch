import * as vscode from 'vscode';
import { chunkFile, isIndexable, RawChunk } from './chunker';
import { saveIndex, loadIndex, indexExists } from './indexStore';
import { Chunk, IndexData, MetaJson } from './types';
import { MODEL_NAME, VECTOR_DIM, ALWAYS_EXCLUDE, float32ToBase64, base64ToFloat32 } from './utils';
import panelHtml from './webview/panel.html';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;

/**
 * Raw chunk metadata kept in memory while the webview computes embeddings.
 * Cleared once the index is saved.
 */
let pendingRawChunks: Array<Omit<RawChunk, 'text'>> = [];

/** Deferred flag: true when `intellisearch.buildIndex` was called before the webview initialised. */
let pendingAutoBuild = false;

/** True once the webview's embedding model has finished loading. */
let isWebviewEmbedReady = false;

/** Pending embed-query requests from the LM tool, keyed by request ID. */
const pendingEmbedRequests = new Map<string, {
	query: string;
	resolve: (v: Float32Array) => void;
	reject: (e: Error) => void;
}>();

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
			pendingRawChunks = [];
			isWebviewEmbedReady = false;
			for (const req of pendingEmbedRequests.values()) {
				req.reject(new Error('IntelliSearch panel was closed before the query could be embedded.'));
			}
			pendingEmbedRequests.clear();
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

		// Webview finished embedding all chunks -----------------------------------
		case 'embeddingsDone': {
			const b64Len = (msg.vectors as string)?.length ?? 0;
			console.log(`[intellisearch] embeddingsDone received — base64 payload ${b64Len} chars, pendingRawChunks=${pendingRawChunks.length}`);
			if (pendingRawChunks.length === 0) {
				panel?.webview.postMessage({
					type: 'error',
					message: 'Received embeddings but chunk metadata was lost. Please rebuild.',
				});
				return;
			}

			const vectors = base64ToFloat32(msg.vectors as string);

			const chunks: Chunk[] = pendingRawChunks.map((rc, i) => ({
				id: i,
				file: rc.file,
				range: rc.range,
				tokenCount: rc.tokenCount,
				preview: rc.preview,
				symbolName: rc.symbolName,
				vectorOffset: i * VECTOR_DIM,
			}));

			const fileMeta: IndexData['files'] = {};
			for (const rc of pendingRawChunks) {
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

			panel?.webview.postMessage({ type: 'savingIndex' });
			console.log(`[intellisearch] saving index — ${chunks.length} chunks, vectors Float32Array(${vectors.length})`);
			await saveIndex(workspaceUri, { meta, chunks, files: fileMeta }, vectors);
			console.log('[intellisearch] index saved to disk');
			pendingRawChunks = [];

			panel?.webview.postMessage({ type: 'indexSaved', meta });
			break;
		}

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

		// Webview model finished loading — flush any queued embed requests --------
		case 'modelReady':
			isWebviewEmbedReady = true;
			for (const [requestId, req] of pendingEmbedRequests) {
				panel?.webview.postMessage({ type: 'embedQuery', requestId, query: req.query });
			}
			break;

		// Webview returned an embedding for a tool search query -------------------
		case 'queryEmbedding': {
			const req = pendingEmbedRequests.get(msg.requestId as string);
			if (req) {
				pendingEmbedRequests.delete(msg.requestId as string);
				req.resolve(base64ToFloat32(msg.vector as string));
			}
			break;
		}

		// Webview failed to embed a query -----------------------------------------
		case 'embedQueryError': {
			const req = pendingEmbedRequests.get(msg.requestId as string);
			if (req) {
				pendingEmbedRequests.delete(msg.requestId as string);
				req.reject(new Error(msg.message as string));
			}
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Indexing orchestration
// ---------------------------------------------------------------------------
async function runBuildIndex(workspaceUri: vscode.Uri): Promise<void> {
	console.log('[intellisearch] runBuildIndex start');
	console.log('[intellisearch] calling findFiles…');
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

		console.log(`[intellisearch] chunking [${i + 1}/${indexable.length}] ${uri.path.split('/').pop()}`);
		try {
			const chunks = await chunkFile(uri, workspaceUri.path);
			console.log(`[intellisearch]   → ${chunks.length} chunk(s)`);
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

	pendingRawChunks = rawChunks.map(({ text: _t, ...meta }) => meta);

	console.log('[intellisearch] posting startEmbedding to webview…');
	panel?.webview.postMessage({
		type: 'startEmbedding',
		chunks: rawChunks.map((rc, i) => ({
			id: i,
			text: rc.text,
			file: rc.file,
			range: rc.range,
			preview: rc.preview,
			symbolName: rc.symbolName,
		})),
	});
}

async function sendIndexToWebview(workspaceUri: vscode.Uri): Promise<void> {
	console.log('[intellisearch] loading existing index from disk…');
	const loaded = await loadIndex(workspaceUri);
	if (!loaded) { console.warn('[intellisearch] loadIndex returned null'); return; }
	console.log(`[intellisearch] index loaded — ${loaded.data.chunks.length} chunks, sending to webview`);
	panel?.webview.postMessage({
		type: 'loadIndex',
		chunks: loaded.data.chunks,
		vectors: float32ToBase64(loaded.vectors),
		meta: loaded.data.meta,
	});
}

// ---------------------------------------------------------------------------
// Embed-query bridge — used by the LM tool to route queries through the webview
// ---------------------------------------------------------------------------
export function embedQueryViaWebview(query: string): Promise<Float32Array> {
	return new Promise<Float32Array>((resolve, reject) => {
		const requestId = Math.random().toString(36).slice(2);
		const timer = setTimeout(() => {
			pendingEmbedRequests.delete(requestId);
			reject(new Error('Embedding timed out after 60 s. The model may still be downloading — try again shortly.'));
		}, 60_000);

		pendingEmbedRequests.set(requestId, {
			query,
			resolve: (v) => { clearTimeout(timer); resolve(v); },
			reject:  (e) => { clearTimeout(timer); reject(e); },
		});

		if (isWebviewEmbedReady) {
			panel?.webview.postMessage({ type: 'embedQuery', requestId, query });
		}
		// else: flushed automatically when modelReady fires
	});
}
