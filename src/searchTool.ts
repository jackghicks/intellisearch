import * as vscode from 'vscode';
import { loadIndex, indexExists } from './indexStore';
import { embedQuery } from './embeddingWorker';
import { VECTOR_DIM } from './utils';

// ---------------------------------------------------------------------------
// LM Tool — semantic search exposed to Copilot agents
// ---------------------------------------------------------------------------

interface SearchInput {
	query: string;
	maxResults?: number;
}

function dotProductF32(a: Float32Array, b: Float32Array): number {
	let s = 0;
	for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; }
	return s;
}

export class IntelliSearchTool implements vscode.LanguageModelTool<SearchInput> {
	constructor(private readonly ctx: vscode.ExtensionContext) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SearchInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { query, maxResults = 8 } = options.input;

		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceUri) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart('No workspace folder is open.'),
			]);
		}

		if (!(await indexExists(workspaceUri))) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(
					'No IntelliSearch index found. Ask the user to run the "IntelliSearch: Build Index" command first.',
				),
			]);
		}

		// Ensure the worker panel is running so the embedding model is available.
		// (initEmbeddingWorker is idempotent — safe to call here as a fallback.)

		let queryVector: Float32Array;
		try {
			queryVector = await embedQuery(query);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Failed to embed query: ${(err as Error).message}`),
			]);
		}

		const loaded = await loadIndex(workspaceUri);
		if (!loaded) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart('Failed to load the search index from disk.'),
			]);
		}

		const { data, vectors } = loaded;
		const scored = data.chunks.map(chunk => ({
			chunk,
			score: dotProductF32(
				queryVector,
				vectors.subarray(chunk.vectorOffset, chunk.vectorOffset + VECTOR_DIM),
			),
		}));
		scored.sort((a, b) => b.score - a.score);
		const top = scored.slice(0, maxResults);

		if (top.length === 0) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart('No results found.'),
			]);
		}

		const lines = [`IntelliSearch results for: "${query}"`, ''];
		for (const [i, { chunk, score }] of top.entries()) {
			const loc = `L${chunk.range.start + 1}-${chunk.range.end + 1}`;
			const sym = chunk.symbolName ? ` [${chunk.symbolName}]` : '';
			const pct = (score * 100).toFixed(1);
			lines.push(`${i + 1}. ${chunk.file}${sym}  ${loc}  (${pct}% match)`);
			lines.push(chunk.preview);
			lines.push('');
		}

		return new vscode.LanguageModelToolResult([
			new vscode.LanguageModelTextPart(lines.join('\n')),
		]);
	}
}
