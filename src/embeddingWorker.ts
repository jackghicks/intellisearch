import * as vscode from 'vscode';
import { base64ToFloat32 } from './utils';
import workerHtml from './webview/worker.html';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let workerPanel: vscode.WebviewPanel | undefined;
let isModelReady = false;

/** Held so the panel can be recreated automatically if the user closes it. */
let savedContext: vscode.ExtensionContext | undefined;

/** Last index stats message — re-sent whenever the panel is recreated. */
let lastIndexStats: Record<string, unknown> | null = null;

/** Pending single-query embed requests, keyed by requestId. */
const pendingQueryRequests = new Map<string, {
	query:   string;
	resolve: (v: Float32Array) => void;
	reject:  (e: Error) => void;
}>();

/** Callbacks for the currently in-progress batch embedding. */
let batchCallbacks: {
	onProgress: (done: number, total: number, file: string) => void;
	resolve:    (v: Float32Array) => void;
	reject:     (e: Error) => void;
} | undefined;

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Creates the background embedding worker panel.  Call once from `activate`.
 * Uses `preserveFocus: true` so it doesn't steal the user's active editor.
 */
export function initEmbeddingWorker(context: vscode.ExtensionContext): void {
	savedContext = context;
	if (workerPanel) { return; }
	createWorkerPanel(context);
}

/** Ensures the worker panel exists, recreating it if the user closed it. */
function ensureWorkerPanel(): void {
	if (!workerPanel && savedContext) {
		createWorkerPanel(savedContext);
	}
}

function createWorkerPanel(context: vscode.ExtensionContext): void {
	const distWebUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'web');

	workerPanel = vscode.window.createWebviewPanel(
		'intellisearch.worker',
		'IntelliSearch Worker',
		{ viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [distWebUri] },
	);

	const webview = workerPanel.webview;
	const transformersUri = webview.asWebviewUri(vscode.Uri.joinPath(distWebUri, 'transformers.min.js')).toString();
	const wasmDirUri      = webview.asWebviewUri(distWebUri).toString() + '/';

	webview.html = workerHtml
		.replace('__CSP_SOURCE__', webview.cspSource)
		.replace('__TRANSFORMERS_URI__', transformersUri)
		.replace('__WASM_DIR_URI__', wasmDirUri);

	webview.onDidReceiveMessage(handleMessage, undefined, context.subscriptions);

	workerPanel.onDidDispose(() => {
		workerPanel   = undefined;
		isModelReady  = false;
		const err = new Error('IntelliSearch embedding worker was closed.');
		for (const req of pendingQueryRequests.values()) { req.reject(err); }
		pendingQueryRequests.clear();
		batchCallbacks?.reject(err);
		batchCallbacks = undefined;
	}, null, context.subscriptions);
}

// ---------------------------------------------------------------------------
// Internal message handler  (worker webview → extension)
// ---------------------------------------------------------------------------
function handleMessage(msg: Record<string, unknown>): void {
	switch (msg.type) {

		// Webview script finished loading — re-send cached stats if available ---
		case 'workerWebviewReady':
			if (lastIndexStats) {
				workerPanel?.webview.postMessage(lastIndexStats);
			}
			break;

		case 'modelReady':
			isModelReady = true;
			// Flush any queries that arrived before the model finished loading.
			for (const [requestId, req] of pendingQueryRequests) {
				workerPanel?.webview.postMessage({ type: 'embedQuery', requestId, query: req.query });
			}
			break;

		case 'modelError':
			console.error('[intellisearch worker] model load failed:', msg.message);
			break;

		case 'embedProgress':
			batchCallbacks?.onProgress(
				msg.done  as number,
				msg.total as number,
				msg.file  as string,
			);
			break;

		case 'embeddingsDone': {
			const cb = batchCallbacks;
			batchCallbacks = undefined;
			cb?.resolve(base64ToFloat32(msg.vectors as string));
			break;
		}

		case 'queryEmbedding': {
			const req = pendingQueryRequests.get(msg.requestId as string);
			if (req) {
				pendingQueryRequests.delete(msg.requestId as string);
				req.resolve(base64ToFloat32(msg.vector as string));
			}
			break;
		}

		case 'embedQueryError': {
			const req = pendingQueryRequests.get(msg.requestId as string);
			if (req) {
				pendingQueryRequests.delete(msg.requestId as string);
				req.reject(new Error(msg.message as string));
			}
			break;
		}
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Embed a batch of chunks for an index build.
 * `onProgress` is called after each chunk with (done, total, file).
 */
export function embedBatch(
	chunks: Array<{ text: string; file: string }>,
	onProgress: (done: number, total: number, file: string) => void,
): Promise<Float32Array> {
	ensureWorkerPanel();
	if (!workerPanel) {
		return Promise.reject(new Error('Embedding worker could not be initialised.'));
	}
	return new Promise<Float32Array>((resolve, reject) => {
		batchCallbacks = { onProgress, resolve, reject };
		workerPanel!.webview.postMessage({ type: 'startEmbedding', chunks });
	});
}

/**
 * Send index stats or any status message to the worker panel's UI.
 * The message is cached and re-delivered if the panel is recreated.
 */
export function postWorkerStatus(msg: Record<string, unknown>): void {
	lastIndexStats = msg;
	workerPanel?.webview.postMessage(msg);
}

/**
 * Embed a single search query.  Queued automatically if the model is still
 * loading; times out after 60 s.
 */
export function embedQuery(query: string): Promise<Float32Array> {
	ensureWorkerPanel();
	if (!workerPanel) {
		return Promise.reject(new Error('Embedding worker could not be initialised.'));
	}
	return new Promise<Float32Array>((resolve, reject) => {
		const requestId = Math.random().toString(36).slice(2);
		const timer = setTimeout(() => {
			pendingQueryRequests.delete(requestId);
			reject(new Error(
				'Embedding timed out after 60 s. The model may still be loading — try again shortly.',
			));
		}, 60_000);

		pendingQueryRequests.set(requestId, {
			query,
			resolve: (v) => { clearTimeout(timer); resolve(v); },
			reject:  (e) => { clearTimeout(timer); reject(e); },
		});

		if (isModelReady) {
			workerPanel!.webview.postMessage({ type: 'embedQuery', requestId, query });
		}
		// else: flushed automatically when modelReady fires
	});
}
