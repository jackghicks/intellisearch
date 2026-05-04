import * as vscode from 'vscode';
import { chunkFile, isIndexable, RawChunk } from './chunker';
import { saveIndex, loadIndex, indexExists } from './indexStore';
import { Chunk, IndexData, MetaJson } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MODEL_NAME = 'jinaai/jina-embeddings-v2-base-code';
const VECTOR_DIM = 768;

// Passing `undefined` as the exclude argument to findFiles makes VS Code merge
// files.exclude + search.exclude settings AND honour .gitignore files
// (controlled by the search.useIgnoreFiles setting, which is on by default).
// We only hard-exclude .intellisearch/ ourselves — everything else is left to
// VS Code / gitignore so that user configuration is respected.
const ALWAYS_EXCLUDE = '**/.intellisearch/**';

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

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('intellisearch.openPanel', () =>
			openPanel(context),
		),
		vscode.commands.registerCommand('intellisearch.buildIndex', () => {
			pendingAutoBuild = true;
			openPanel(context);
		}),
	);

	openPanel(context);
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------
// Panel management
// ---------------------------------------------------------------------------
async function openPanel(context: vscode.ExtensionContext): Promise<void> {
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

	panel.webview.html = getWebviewHtml();

	panel.webview.onDidReceiveMessage(
		(msg) => handleMessage(msg, context),
		undefined,
		context.subscriptions,
	);

	panel.onDidDispose(
		() => { panel = undefined; pendingRawChunks = []; },
		null,
		context.subscriptions,
	);
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
			await runBuildIndex(workspaceUri);
			break;

		// Webview finished embedding all chunks -----------------------------------
		case 'embeddingsDone': {
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
			await saveIndex(workspaceUri, { meta, chunks, files: fileMeta }, vectors);
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
	}
}

// ---------------------------------------------------------------------------
// Indexing orchestration
// ---------------------------------------------------------------------------
async function runBuildIndex(workspaceUri: vscode.Uri): Promise<void> {
	// undefined exclude → VS Code applies files.exclude + search.exclude + .gitignore.
	// We additionally strip .intellisearch/ so we never index our own output.
	const files = await vscode.workspace.findFiles('**/*', ALWAYS_EXCLUDE);
	const indexable = files.filter(isIndexable);

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
			rawChunks.push(...chunks);
		} catch (err) {
			console.warn('intellisearch: skip', uri.path, err);
		}
	}

	if (rawChunks.length === 0) {
		panel?.webview.postMessage({
			type: 'error',
			message: 'No indexable content found in the workspace.',
		});
		return;
	}

	// Persist metadata (without text) for index assembly after embedding.
	pendingRawChunks = rawChunks.map(({ text: _t, ...meta }) => meta);

	// Send chunks (with text included) to the webview for embedding.
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
	const loaded = await loadIndex(workspaceUri);
	if (!loaded) { return; }
	panel?.webview.postMessage({
		type: 'loadIndex',
		chunks: loaded.data.chunks,
		vectors: float32ToBase64(loaded.vectors),
		meta: loaded.data.meta,
	});
}

// ---------------------------------------------------------------------------
// Float32 ↔ Base64  (btoa / atob are available in the web-worker host)
// ---------------------------------------------------------------------------
function float32ToBase64(arr: Float32Array): string {
	const bytes = new Uint8Array(arr.buffer);
	const CHUNK = 0x8000; // 32 768 — safe upper bound for spread
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(binary);
}

function base64ToFloat32(b64: string): Float32Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	const aligned = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(aligned).set(bytes);
	return new Float32Array(aligned);
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------
function getWebviewHtml(): string {
	return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
	content="default-src 'none';
		script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net blob:;
		connect-src https: blob: data:;
		worker-src blob:;
		style-src 'unsafe-inline';">
<title>IntelliSearch</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
	font-family:var(--vscode-font-family,sans-serif);
	font-size:var(--vscode-font-size,13px);
	background:var(--vscode-editor-background,#1e1e1e);
	color:var(--vscode-editor-foreground,#d4d4d4);
	padding:14px;display:flex;flex-direction:column;gap:10px
}
header{display:flex;align-items:center;justify-content:space-between;gap:8px}
h2{font-size:1.05em;font-weight:600;white-space:nowrap}
.badge{
	padding:2px 8px;border-radius:10px;font-size:.8em;white-space:nowrap;
	background:var(--vscode-badge-background,#4d4d4d);
	color:var(--vscode-badge-foreground,#fff)
}
.badge.ok{background:var(--vscode-testing-iconPassed,#4ec9b0);color:#000}
.badge.err{background:var(--vscode-inputValidation-errorBackground,#5a1d1d);color:var(--vscode-inputValidation-errorForeground,#f48771)}
button{
	background:var(--vscode-button-background,#0e639c);
	color:var(--vscode-button-foreground,#fff);
	border:none;padding:5px 14px;cursor:pointer;border-radius:2px;font:inherit;font-size:.9em
}
button:disabled{opacity:.45;cursor:default}
button:not(:disabled):hover{background:var(--vscode-button-hoverBackground,#1177bb)}
#actions{display:flex;gap:8px;align-items:center}
#progress-section{display:none;flex-direction:column;gap:4px}
#progress-label{font-size:.85em;color:var(--vscode-descriptionForeground,#888)}
.pbar{background:var(--vscode-editorWidget-border,#454545);height:3px;border-radius:2px;overflow:hidden}
#pbar-fill{background:var(--vscode-progressBar-background,#0e70c0);height:100%;width:0%;transition:width .25s ease}
#progress-detail{font-size:.8em;color:var(--vscode-descriptionForeground,#666);font-family:var(--vscode-editor-font-family,monospace)}
#search-section{display:none;flex-direction:column;gap:8px}
.search-row{display:flex;gap:6px}
#search-input{
	flex:1;background:var(--vscode-input-background,#3c3c3c);
	color:var(--vscode-input-foreground,#d4d4d4);
	border:1px solid var(--vscode-input-border,#555);
	padding:5px 8px;border-radius:2px;font:inherit
}
#search-input:focus{outline:1px solid var(--vscode-focusBorder,#007fd4);border-color:var(--vscode-focusBorder,#007fd4)}
#results{display:flex;flex-direction:column;gap:6px;max-height:65vh;overflow-y:auto}
.result{
	padding:8px 10px;
	background:var(--vscode-list-inactiveSelectionBackground,#2a2d2e);
	border:1px solid transparent;border-radius:3px;cursor:pointer
}
.result:hover{
	background:var(--vscode-list-hoverBackground,#2a2d2e);
	border-color:var(--vscode-list-focusHighlightForeground,#3a3d3e)
}
.result-header{display:flex;gap:6px;align-items:baseline;font-size:.82em;margin-bottom:4px;flex-wrap:wrap}
.result-file{color:var(--vscode-textLink-foreground,#3794ff);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.result-loc{color:var(--vscode-descriptionForeground,#888);white-space:nowrap}
.result-sym{color:var(--vscode-symbolIcon-functionForeground,#dcdcaa);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:180px}
.result-score{color:var(--vscode-charts-green,#4ec9b0);font-weight:600;white-space:nowrap}
.result-preview{
	font-family:var(--vscode-editor-font-family,monospace);font-size:11px;
	white-space:pre-wrap;overflow:hidden;max-height:3.8em;
	color:var(--vscode-editor-foreground,#d4d4d4);opacity:.8
}
.no-results{color:var(--vscode-descriptionForeground,#888);font-size:.9em;padding:8px 0}
</style>
</head>
<body>

<header>
	<h2>&#x1F50D; IntelliSearch</h2>
	<span id="badge" class="badge">Initializing\u2026</span>
</header>

<div id="actions">
	<button id="btn-build" disabled>Build Index</button>
</div>

<div id="progress-section">
	<div id="progress-label">\u2026</div>
	<div class="pbar"><div id="pbar-fill"></div></div>
	<div id="progress-detail"></div>
</div>

<div id="search-section">
	<div class="search-row">
		<input id="search-input" type="text" placeholder="Describe what you\u2019re looking for\u2026"
			autocomplete="off" spellcheck="false" />
		<button id="btn-search">Search</button>
	</div>
	<div id="results"></div>
</div>

<script type="module">
const vscode = acquireVsCodeApi();

// DOM refs
const badge         = document.getElementById('badge');
const btnBuild      = document.getElementById('btn-build');
const progressSec   = document.getElementById('progress-section');
const progressLabel = document.getElementById('progress-label');
const pbarFill      = document.getElementById('pbar-fill');
const progressDet   = document.getElementById('progress-detail');
const searchSec     = document.getElementById('search-section');
const searchInput   = document.getElementById('search-input');
const btnSearch     = document.getElementById('btn-search');
const resultsEl     = document.getElementById('results');

// Runtime state
let extractor   = null;
let modelLoading = false;
let isIndexing  = false;
let indexChunks  = null;   // Array<Chunk>  — for search result display
let indexVectors = null;   // Float32Array  — one 768-dim vector per chunk

// UI helpers
function setBadge(text, cls) {
	badge.textContent = text;
	badge.className = 'badge' + (cls ? ' ' + cls : '');
}
function showProgress(label, pct, detail) {
	progressSec.style.display = 'flex';
	progressLabel.textContent = label;
	pbarFill.style.width = Math.max(0, Math.min(100, pct)) + '%';
	progressDet.textContent = detail || '';
}
function hideProgress() { progressSec.style.display = 'none'; }
function showSearch()   { searchSec.style.display = 'flex'; }

// Float32 <-> Base64
function float32ToBase64(arr) {
	const bytes = new Uint8Array(arr.buffer);
	const CHUNK = 0x8000;
	let bin = '';
	for (let i = 0; i < bytes.length; i += CHUNK)
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	return btoa(bin);
}
function base64ToFloat32(b64) {
	const bin = atob(b64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	const buf = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(buf).set(bytes);
	return new Float32Array(buf);
}

// Model loading (lazy, idempotent)
async function ensureModel() {
	if (extractor) return extractor;
	if (modelLoading) {
		while (modelLoading) await new Promise(r => setTimeout(r, 150));
		return extractor;
	}
	modelLoading = true;
	setBadge('Loading model\u2026');
	try {
		const { pipeline, env } = await import(
			'https://cdn.jsdelivr.net/npm/@xenova/transformers@2/dist/transformers.min.js'
		);
		env.allowLocalModels = false;
		extractor = await pipeline(
			'feature-extraction',
			'jinaai/jina-embeddings-v2-base-code',
			{
				quantized: true,
				progress_callback: p => {
					if (p.status === 'download' && p.progress != null)
						setBadge('Downloading model: ' + p.progress.toFixed(1) + '%');
				},
			}
		);
		setBadge('Model ready', 'ok');
		return extractor;
	} finally {
		modelLoading = false;
	}
}

// Dot product == cosine similarity when both vectors are L2-normalised.
function dotProduct(a, b) {
	let s = 0;
	for (let i = 0; i < a.length; i++) s += a[i] * b[i];
	return s;
}

// Embedding loop
async function handleStartEmbedding(chunks) {
	isIndexing = true;
	btnBuild.disabled = true;
	const model = await ensureModel();
	const DIM   = 768;
	const BATCH = 4;
	const total = chunks.length;
	const allVec = new Float32Array(total * DIM);

	for (let i = 0; i < total; i += BATCH) {
		const batch = chunks.slice(i, i + BATCH);
		try {
			const out = await model(batch.map(c => c.text), { pooling: 'mean', normalize: true });
			allVec.set(out.data, i * DIM);
		} catch {
			for (let j = 0; j < batch.length; j++) {
				try {
					const out = await model(batch[j].text, { pooling: 'mean', normalize: true });
					allVec.set(out.data, (i + j) * DIM);
				} catch { /* leave as zero vector */ }
			}
		}
		const done = Math.min(i + BATCH, total);
		showProgress('Embedding chunks\u2026', (done / total) * 100, done + ' / ' + total);
	}

	// Cache index in-memory so search works immediately without reloading.
	indexChunks  = chunks.map((c, idx) => ({
		id: c.id, file: c.file, range: c.range,
		preview: c.preview, symbolName: c.symbolName,
		vectorOffset: idx * DIM,
	}));
	indexVectors = allVec;

	showProgress('Saving index\u2026', 100);
	setBadge('Saving\u2026');
	vscode.postMessage({ type: 'embeddingsDone', vectors: float32ToBase64(allVec) });
}

// Search
async function runSearch() {
	const query = searchInput.value.trim();
	if (!query) return;
	if (!indexChunks || !indexVectors) { setBadge('No index loaded', 'err'); return; }

	btnSearch.disabled = true;
	setBadge('Searching\u2026');
	try {
		const model = await ensureModel();
		const out   = await model(query, { pooling: 'mean', normalize: true });
		const qvec  = out.data;
		const DIM   = 768;

		const scored = indexChunks.map(chunk => {
			const vec = indexVectors.subarray(chunk.vectorOffset, chunk.vectorOffset + DIM);
			return { chunk, score: dotProduct(qvec, vec) };
		});
		scored.sort((a, b) => b.score - a.score);
		displayResults(scored.slice(0, 10));
		setBadge(indexChunks.length + ' chunks indexed', 'ok');
	} catch (err) {
		setBadge('Search error: ' + err.message, 'err');
	} finally {
		btnSearch.disabled = false;
	}
}

// Results rendering
function esc(s)  { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escA(s) { return s.replace(/"/g,'&quot;'); }

function displayResults(results) {
	if (!results.length) {
		resultsEl.innerHTML = '<p class="no-results">No results found.</p>';
		return;
	}
	resultsEl.innerHTML = results.map(({ chunk, score }) => {
		const pct = (score * 100).toFixed(1);
		const loc = 'L' + (chunk.range.start + 1) + '\u2013' + (chunk.range.end + 1);
		const sym = chunk.symbolName
			? '<span class="result-sym">' + esc(chunk.symbolName) + '</span>' : '';
		return '<div class="result"' +
			' data-file="' + escA(chunk.file) + '"' +
			' data-start="' + chunk.range.start + '"' +
			' data-end="'   + chunk.range.end   + '">' +
			'<div class="result-header">' +
				'<span class="result-file">'  + esc(chunk.file) + '</span>' +
				'<span class="result-loc">'   + loc + '</span>' +
				sym +
				'<span class="result-score">' + pct + '%</span>' +
			'</div>' +
			'<pre class="result-preview">' + esc(chunk.preview) + '</pre>' +
			'</div>';
	}).join('');

	resultsEl.querySelectorAll('.result').forEach(el => {
		el.addEventListener('click', () => vscode.postMessage({
			type: 'openFile',
			file:  el.dataset.file,
			start: +el.dataset.start,
			end:   +el.dataset.end,
		}));
	});
}

// Message handler (extension -> webview)
window.addEventListener('message', async e => {
	const msg = e.data;
	switch (msg.type) {

		case 'init':
			btnBuild.disabled = false;
			btnBuild.textContent = msg.hasIndex ? 'Rebuild Index' : 'Build Index';
			setBadge(msg.hasIndex ? 'Loading index\u2026' : 'No index yet');
			if (msg.autoBuild) setTimeout(() => btnBuild.click(), 50);
			break;

		case 'loadIndex':
			setBadge('Decoding index\u2026');
			await new Promise(r => setTimeout(r, 0)); // yield to keep UI responsive
			indexChunks  = msg.chunks;
			indexVectors = base64ToFloat32(msg.vectors);
			setBadge(indexChunks.length + ' chunks indexed', 'ok');
			btnBuild.disabled = false;
			btnBuild.textContent = 'Rebuild Index';
			showSearch();
			break;

		case 'triggerBuild':
			if (!isIndexing && !btnBuild.disabled) btnBuild.click();
			break;

		case 'chunkStart':
			showProgress('Chunking files\u2026', 0, '0 / ' + msg.total);
			setBadge('Chunking\u2026');
			break;

		case 'chunkProgress':
			showProgress(
				'Chunking files\u2026',
				(msg.done / msg.total) * 100,
				msg.done + ' / ' + msg.total + '  \u2014  ' + msg.file,
			);
			break;

		case 'startEmbedding':
			setBadge('Embedding ' + msg.chunks.length + ' chunks\u2026');
			await handleStartEmbedding(msg.chunks);
			break;

		case 'savingIndex':
			showProgress('Saving index\u2026', 100);
			setBadge('Saving\u2026');
			break;

		case 'indexSaved':
			hideProgress();
			setBadge(msg.meta.chunkCount + ' chunks indexed', 'ok');
			isIndexing = false;
			btnBuild.disabled = false;
			btnBuild.textContent = 'Rebuild Index';
			showSearch();
			searchInput.focus();
			break;

		case 'error':
			hideProgress();
			setBadge('Error: ' + msg.message, 'err');
			isIndexing = false;
			btnBuild.disabled = false;
			break;
	}
});

// Button / keyboard wiring
btnBuild.addEventListener('click', () => {
	if (isIndexing) return;
	isIndexing = true;
	btnBuild.disabled = true;
	searchSec.style.display = 'none';
	resultsEl.innerHTML = '';
	vscode.postMessage({ type: 'buildIndex' });
});

searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });
btnSearch.addEventListener('click', runSearch);

// Announce ready to the extension host
vscode.postMessage({ type: 'webviewReady' });
</script>
</body>
</html>`;
}
