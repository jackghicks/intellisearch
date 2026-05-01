import * as vscode from 'vscode';

let currentPanel: vscode.WebviewPanel | undefined;

export function activate(context: vscode.ExtensionContext) {
	console.log('intellisearch is now active!');

	const openPanel = () => {
		if (currentPanel) {
			currentPanel.reveal(vscode.ViewColumn.Two);
			return;
		}

		currentPanel = vscode.window.createWebviewPanel(
			'intellisearch.panel',
			'IntelliSearch',
			vscode.ViewColumn.Two,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
			}
		);

		currentPanel.webview.html = getWebviewContent();

		currentPanel.onDidDispose(() => {
			currentPanel = undefined;
		}, null, context.subscriptions);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand('intellisearch.openPanel', openPanel)
	);

	// Open automatically on activation
	openPanel();
}

function getWebviewContent(): string {
	return `<!DOCTYPE html>
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
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family, sans-serif);
			font-size: var(--vscode-font-size, 13px);
			background: var(--vscode-editor-background, #1e1e1e);
			color: var(--vscode-editor-foreground, #d4d4d4);
			padding: 16px;
		}
		h2 { font-size: 1.1em; margin-bottom: 12px; font-weight: 600; }
		#status {
			padding: 6px 10px;
			border-radius: 3px;
			margin-bottom: 12px;
			background: var(--vscode-badge-background, #4d4d4d);
			color: var(--vscode-badge-foreground, #fff);
			font-size: 0.9em;
		}
		#output {
			white-space: pre-wrap;
			font-family: var(--vscode-editor-font-family, monospace);
			font-size: 12px;
			line-height: 1.5;
			background: var(--vscode-textCodeBlock-background, #252526);
			color: var(--vscode-editor-foreground, #d4d4d4);
			padding: 12px;
			border-radius: 4px;
			border: 1px solid var(--vscode-panel-border, #333);
			overflow: auto;
			max-height: 600px;
		}
	</style>
</head>
<body>
	<h2>IntelliSearch — ONNX Embedding POC</h2>
	<div id="status">Initializing…</div>
	<div id="output"></div>

	<script type="module">
		const statusEl = document.getElementById('status');
		const outputEl = document.getElementById('output');

		const log = (msg) => {
			outputEl.textContent += msg + '\\n';
			outputEl.scrollTop = outputEl.scrollHeight;
		};
		const setStatus = (msg) => { statusEl.textContent = msg; };

		try {
			setStatus('Importing @xenova/transformers from CDN…');
			log('[1/4] Importing @xenova/transformers@2 from cdn.jsdelivr.net…');

			const { pipeline, env } = await import(
				'https://cdn.jsdelivr.net/npm/@xenova/transformers@2/dist/transformers.min.js'
			);

			log('[1/4] ✓ Import successful.');
			log('');
			log('[2/4] Loading model: jinaai/jina-embeddings-v2-base-code');
			log('      (quantized ONNX — first run downloads ~100 MB and caches it)');
			setStatus('Downloading / loading model… (may take a while on first run)');

			const extractor = await pipeline(
				'feature-extraction',
				'jinaai/jina-embeddings-v2-base-code',
				{ quantized: true }
			);

			log('[2/4] ✓ Model loaded!');
			log('');
			log('[3/4] Generating embedding for test string…');
			setStatus('Generating embedding…');

			const testString = 'function greet(name) { return "Hello, " + name + "!"; }';
			log('      Input: ' + testString);

			const result = await extractor(testString, { pooling: 'mean', normalize: true });

			log('[3/4] ✓ Embedding generated!');
			log('');
			log('[4/4] Results');
			log('      Shape : [' + result.dims.join(', ') + ']');
			log('      Dtype : ' + result.type);
			log('      First 8 values:');
			log('      [' + Array.from(result.data).slice(0, 8).map(v => Number(v).toFixed(8)).join(', ') + ']');
			log('');
			log('✓ Success! ONNX Runtime Web + jina-embeddings-v2-base-code is working.');
			setStatus('✓ Done — embedding generated successfully!');

		} catch (err) {
			setStatus('✗ Error: ' + err.message);
			log('ERROR: ' + err.toString());
			if (err.stack) { log(''); log(err.stack); }
		}
	</script>
</body>
</html>`;
}

export function deactivate() {}
