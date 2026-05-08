import * as vscode from 'vscode';
import { chunkFile, isIndexable, RawChunk } from './chunker';
import { saveIndex, loadIndex, indexExists } from './indexStore';
import { Chunk, IndexData, MetaJson } from './types';
import { MODEL_NAME, VECTOR_DIM, ALWAYS_EXCLUDE } from './utils';
import { embedBatch, embedQuery, postWorkerStatus } from './embeddingWorker';
import panelHtml from './webview/panel.html';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------
let panel: vscode.WebviewPanel | undefined;

/** Deferred flag: true when `intellisearch.buildIndex` was called before the webview initialised. */
let pendingAutoBuild = false;

/** Index held in extension-host memory for fast search. */
let inMemoryIndex: { data: IndexData; vectors: Float32Array } | null = null;

/** Guards against running a full build and an incremental update concurrently. */
let isFullBuildInProgress = false;
let isIncrementalUpdating = false;

/** Timestamp of the most recent full build (ms). */
let lastFullBuildTime: number | null = null;

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
	isFullBuildInProgress = true;
	try {
		await doBuildIndex(workspaceUri);
	} finally {
		isFullBuildInProgress = false;
	}
}

async function doBuildIndex(workspaceUri: vscode.Uri): Promise<void> {
	const files = await vscode.workspace.findFiles('**/*', ALWAYS_EXCLUDE);
	const indexable = files.filter(isIndexable);
	console.log(`[intellisearch] findFiles done — total=${files.length}, indexable=${indexable.length}`);

	panel?.webview.postMessage({ type: 'chunkStart', total: indexable.length });

	const rawChunks: RawChunk[] = [];
	const fileMtimes = new Map<string, number>();

	for (let i = 0; i < indexable.length; i++) {
		const uri = indexable[i];
		panel?.webview.postMessage({
			type: 'chunkProgress',
			done: i + 1,
			total: indexable.length,
			file: uri.path.split('/').pop() ?? '',
		});
		try {
			const [chunks, stat] = await Promise.all([
				chunkFile(uri, workspaceUri.path),
				vscode.workspace.fs.stat(uri).then(s => s, () => null),
			]);
			console.log(`[intellisearch]   → ${chunks.length} chunk(s) from ${uri.path.split('/').pop()}`);
			rawChunks.push(...chunks);
			if (stat) {
				fileMtimes.set(uriToRelPath(uri, workspaceUri), stat.mtime);
			}
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
	// Populate real mtimes captured during chunking.
	for (const [rel, mtime] of fileMtimes) {
		if (fileMeta[rel]) { fileMeta[rel].mtime = mtime; }
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
	lastFullBuildTime = Date.now();
	console.log('[intellisearch] index saved to disk');

	postWorkerStatus({
		type: 'indexStats',
		chunkCount:     chunks.length,
		fileCount:      Object.keys(fileMeta).length,
		lastFullBuild:  lastFullBuildTime,
		lastIncremental: null,
	});

	panel?.webview.postMessage({ type: 'indexSaved', meta });
}

async function sendIndexToWebview(workspaceUri: vscode.Uri): Promise<void> {
	console.log('[intellisearch] loading existing index from disk…');
	const loaded = await loadIndex(workspaceUri);
	if (!loaded) { console.warn('[intellisearch] loadIndex returned null'); return; }
	inMemoryIndex = loaded;
	console.log(`[intellisearch] index loaded — ${loaded.data.chunks.length} chunks`);

	postWorkerStatus({
		type:            'indexStats',
		chunkCount:      loaded.data.chunks.length,
		fileCount:       Object.keys(loaded.data.files).length,
		lastFullBuild:   loaded.data.meta.created,
		lastIncremental: null,
	});

	panel?.webview.postMessage({
		type:       'loadIndex',
		chunkCount: loaded.data.chunks.length,
		meta:       loaded.data.meta,
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function uriToRelPath(uri: vscode.Uri, workspaceUri: vscode.Uri): string {
	return uri.path.startsWith(workspaceUri.path + '/')
		? uri.path.slice(workspaceUri.path.length + 1)
		: uri.path;
}

// ---------------------------------------------------------------------------
// Incremental index update  (called by the file watcher in extension.ts)
// ---------------------------------------------------------------------------
export async function runIncrementalUpdate(
	workspaceUri: vscode.Uri,
	changed: vscode.Uri[],
	deleted: vscode.Uri[],
): Promise<void> {
	// If a full build is running, it will produce a fresh index — skip.
	if (isFullBuildInProgress || isIncrementalUpdating) { return; }

	// Ignore non-indexable files and anything inside .intellisearch/.
	const toReindex = changed.filter(
		u => isIndexable(u) && !u.path.includes('/.intellisearch/'),
	);
	const toDelete = deleted.filter(
		u => isIndexable(u) && !u.path.includes('/.intellisearch/'),
	);

	if (toReindex.length === 0 && toDelete.length === 0) { return; }

	// Need an existing index to update.
	if (!inMemoryIndex) {
		const loaded = await loadIndex(workspaceUri);
		if (!loaded) { return; }
		inMemoryIndex = loaded;
	}

	isIncrementalUpdating = true;
	try {
		await doIncrementalUpdate(workspaceUri, toReindex, toDelete);
	} finally {
		isIncrementalUpdating = false;
	}
}

async function doIncrementalUpdate(
	workspaceUri: vscode.Uri,
	toReindex: vscode.Uri[],
	toDelete: vscode.Uri[],
): Promise<void> {
	const index = inMemoryIndex!;

	// Relative paths being removed: deleted files + old versions of changed files.
	const removedRel = new Set<string>([
		...toDelete.map(u => uriToRelPath(u, workspaceUri)),
		...toReindex.map(u => uriToRelPath(u, workspaceUri)),
	]);

	// --- 1. Keep chunks whose file is not being touched ----------------------
	const keepChunks = index.data.chunks.filter(c => !removedRel.has(c.file));

	// --- 2. Re-chunk changed / created files ---------------------------------
	const rawChunks: RawChunk[] = [];
	for (const uri of toReindex) {
		try {
			const chunks = await chunkFile(uri, workspaceUri.path);
			rawChunks.push(...chunks);
		} catch (err) {
			console.warn('[intellisearch] incremental: skip', uri.path, err);
		}
	}

	// --- 3. Embed new chunks (silent — no panel progress) --------------------
	let newVectors: Float32Array = new Float32Array(rawChunks.length * VECTOR_DIM);
	if (rawChunks.length > 0) {
		try {
			newVectors = await embedBatch(
				rawChunks.map(rc => ({ text: rc.text, file: rc.file })),
				() => { /* silent */ },
			);
		} catch (err) {
			console.error('[intellisearch] incremental embedBatch failed:', err);
			return;
		}
	}

	// --- 4. Repack into a contiguous Float32Array, reassigning offsets --------
	const totalChunks = keepChunks.length + rawChunks.length;
	const packedVectors = new Float32Array(totalChunks * VECTOR_DIM);
	const allChunks: Chunk[] = [];

	for (let i = 0; i < keepChunks.length; i++) {
		const src = index.vectors.subarray(
			keepChunks[i].vectorOffset,
			keepChunks[i].vectorOffset + VECTOR_DIM,
		);
		packedVectors.set(src, i * VECTOR_DIM);
		allChunks.push({ ...keepChunks[i], id: i, vectorOffset: i * VECTOR_DIM });
	}

	for (let i = 0; i < rawChunks.length; i++) {
		const globalIdx = keepChunks.length + i;
		packedVectors.set(
			newVectors.subarray(i * VECTOR_DIM, (i + 1) * VECTOR_DIM),
			globalIdx * VECTOR_DIM,
		);
		allChunks.push({
			id:          globalIdx,
			file:        rawChunks[i].file,
			range:       rawChunks[i].range,
			tokenCount:  rawChunks[i].tokenCount,
			preview:     rawChunks[i].preview,
			symbolName:  rawChunks[i].symbolName,
			vectorOffset: globalIdx * VECTOR_DIM,
		});
	}

	// --- 5. Rebuild file metadata --------------------------------------------
	const fileMeta: IndexData['files'] = {};
	for (const chunk of allChunks) {
		const fm = fileMeta[chunk.file] ?? { mtime: 0, chunkCount: 0 };
		fm.chunkCount += 1;
		fileMeta[chunk.file] = fm;
	}
	// Carry over stored mtimes for untouched files.
	for (const [file, stored] of Object.entries(index.data.files)) {
		if (fileMeta[file] && !removedRel.has(file)) {
			fileMeta[file].mtime = stored.mtime;
		}
	}
	// Set fresh mtimes for re-indexed files.
	for (const uri of toReindex) {
		const rel = uriToRelPath(uri, workspaceUri);
		if (fileMeta[rel]) {
			try {
				const stat = await vscode.workspace.fs.stat(uri);
				fileMeta[rel].mtime = stat.mtime;
			} catch { /* ignore */ }
		}
	}

	// --- 6. Save -------------------------------------------------------------
	const updatedMeta: MetaJson = {
		...index.data.meta,
		chunkCount: allChunks.length,
		created: Date.now(),
	};
	const indexData: IndexData = { meta: updatedMeta, chunks: allChunks, files: fileMeta };
	await saveIndex(workspaceUri, indexData, packedVectors);
	inMemoryIndex = { data: indexData, vectors: packedVectors };

	console.log(
		`[intellisearch] incremental: +${toReindex.length} re-indexed, ` +
		`-${toDelete.length} deleted, total ${allChunks.length} chunks`,
	);

	postWorkerStatus({
		type:         'indexStats',
		chunkCount:   allChunks.length,
		fileCount:    Object.keys(fileMeta).length,
		lastFullBuild: lastFullBuildTime,
		lastIncremental: {
			time:         Date.now(),
			changedCount: toReindex.length,
			deletedCount: toDelete.length,
		},
	});

	// Notify the UI panel (if open) so the badge stays current.
	panel?.webview.postMessage({
		type:         'incrementalUpdate',
		chunkCount:   allChunks.length,
		changedCount: toReindex.length,
		deletedCount: toDelete.length,
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
