import * as vscode from 'vscode';
import { base64ToFloat32 } from './utils';
import workerHtml from './webview/worker.html';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let workerView: vscode.WebviewView | undefined;
let isModelReady = false;

/** Held so the view can be recreated automatically if the user closes it. */
let savedContext: vscode.ExtensionContext | undefined;

/** Resolves when the worker WebviewView has been resolved by VS Code. */
let resolveViewReady: (() => void) | undefined;
let viewReadyPromise: Promise<void> = new Promise(r => { resolveViewReady = r; });

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
// Sidebar WebviewView provider
// ---------------------------------------------------------------------------
export class IntelliSearchWorkerProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'intellisearch.worker';

	constructor(private readonly _context: vscode.ExtensionContext) {
		savedContext = _context;
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_resolveContext: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		workerView = webviewView;

		const distWebUri = vscode.Uri.joinPath(this._context.extensionUri, 'dist', 'web');
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [distWebUri],
		};

		const webview = webviewView.webview;
		const transformersUri = webview.asWebviewUri(vscode.Uri.joinPath(distWebUri, 'transformers.min.js')).toString();
		const wasmDirUri      = webview.asWebviewUri(distWebUri).toString() + '/';

		webview.html = workerHtml
			.replace('__CSP_SOURCE__', webview.cspSource)
			.replace('__TRANSFORMERS_URI__', transformersUri)
			.replace('__WASM_DIR_URI__', wasmDirUri);

		webview.onDidReceiveMessage(handleMessage, undefined, this._context.subscriptions);

		webviewView.onDidDispose(() => {
			workerView   = undefined;
			isModelReady = false;
			const err = new Error('IntelliSearch embedding worker was closed.');
			for (const req of pendingQueryRequests.values()) { req.reject(err); }
			pendingQueryRequests.clear();
			batchCallbacks?.reject(err);
			batchCallbacks = undefined;
			// Reset ready promise so ensureWorkerView works after re-open.
			viewReadyPromise = new Promise(r => { resolveViewReady = r; });
		});

		// Signal that the view is now available.
		resolveViewReady?.();
		resolveViewReady = undefined;
	}
}

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/**
 * Triggers the background embedding worker view to load.  Call once from `activate`.
 */
export function initEmbeddingWorker(context: vscode.ExtensionContext): void {
	savedContext = context;
	// Focus the worker view so VS Code resolves it and the WASM model
	// begins loading immediately, before the user opens the main panel.
	vscode.commands.executeCommand('intellisearch.worker.focus');
}

/** Ensures the worker view exists, re-focusing it if the user closed it. */
async function ensureWorkerView(): Promise<void> {
	if (workerView) { return; }
	await vscode.commands.executeCommand('intellisearch.worker.focus');
	await viewReadyPromise;
}

// ---------------------------------------------------------------------------
// Internal message handler  (worker webview → extension)
// ---------------------------------------------------------------------------
function handleMessage(msg: Record<string, unknown>): void {
	switch (msg.type) {

		// Webview script finished loading — re-send cached stats if available ---
		case 'workerWebviewReady':
			if (lastIndexStats) {
				workerView?.webview.postMessage(lastIndexStats);
			}
			break;

		case 'modelReady':
			isModelReady = true;
			// Flush any queries that arrived before the model finished loading.
			for (const [requestId, req] of pendingQueryRequests) {
				workerView?.webview.postMessage({ type: 'embedQuery', requestId, query: req.query });
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
export async function embedBatch(
	chunks: Array<{ text: string; file: string }>,
	onProgress: (done: number, total: number, file: string) => void,
): Promise<Float32Array> {
	await ensureWorkerView();
	return new Promise<Float32Array>((resolve, reject) => {
		batchCallbacks = { onProgress, resolve, reject };
		workerView!.webview.postMessage({ type: 'startEmbedding', chunks });
	});
}

/**
 * Send index stats or any status message to the worker panel's UI.
 * The message is cached and re-delivered if the panel is recreated.
 */
export function postWorkerStatus(msg: Record<string, unknown>): void {
	lastIndexStats = msg;
	workerView?.webview.postMessage(msg);
}

/**
 * Embed a single search query.  Queued automatically if the model is still
 * loading; times out after 60 s.
 */
export async function embedQuery(query: string): Promise<Float32Array> {
	await ensureWorkerView();
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
			workerView!.webview.postMessage({ type: 'embedQuery', requestId, query });
		}
		// else: flushed automatically when modelReady fires
	});
}
