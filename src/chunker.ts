import * as vscode from 'vscode';

// ---- Sizing constants -----------------------------------------------------------
//   jina-embeddings-v2-base-code: 8 192-token context window.
//   Target ~350 tokens ≈ 1 400 chars; hard ceiling 1 500 tokens ≈ 6 000 chars.
const MIN_CHARS = 80;
const MAX_CHARS = 6_000;

// Line-based fallback: 40 lines per chunk with a 5-line overlap.
const LINES_PER_CHUNK = 40;
const OVERLAP_LINES = 5;

// ---- File-type filter -----------------------------------------------------------
const INDEXABLE_EXT = new Set([
	'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
	'.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala',
	'.c', '.cpp', '.h', '.hpp', '.cs', '.swift',
	'.php', '.lua',
	'.vue', '.svelte',
	'.md', '.mdx', '.rst',
	'.json', '.yaml', '.yml', '.toml', '.xml',
	'.sh', '.bash', '.zsh', '.fish',
	'.css', '.scss', '.less', '.sql',
]);

export function isIndexable(uri: vscode.Uri): boolean {
	const lower = uri.path.toLowerCase();
	const dot = lower.lastIndexOf('.');
	return dot !== -1 && INDEXABLE_EXT.has(lower.slice(dot));
}

// ---- Public types ---------------------------------------------------------------
export interface RawChunk {
	file: string;
	range: { start: number; end: number };
	tokenCount: number;
	preview: string;
	symbolName?: string;
	text: string;
}

// ---- Public API -----------------------------------------------------------------
export async function chunkFile(
	uri: vscode.Uri,
	workspaceRootPath: string,
): Promise<RawChunk[]> {
	const doc = await vscode.workspace.openTextDocument(uri);

	// Compute workspace-relative path using URI path segments (always forward-slash).
	const relPath = uri.path.startsWith(workspaceRootPath + '/')
		? uri.path.slice(workspaceRootPath.length + 1)
		: uri.path;

	// Prefer semantic symbol-based chunks when a language server is available.
	try {
		const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
			'vscode.executeDocumentSymbolProvider',
			uri,
		);
		if (symbols && symbols.length > 0) {
			const chunks = chunksFromSymbols(doc, symbols, relPath);
			if (chunks.length > 0) {
				return chunks;
			}
		}
	} catch {
		// No symbol provider for this language — fall through.
	}

	return chunksFromLines(doc, relPath);
}

// ---- Symbol-based chunking ------------------------------------------------------
function chunksFromSymbols(
	doc: vscode.TextDocument,
	symbols: vscode.DocumentSymbol[],
	relPath: string,
): RawChunk[] {
	const chunks: RawChunk[] = [];

	function visit(syms: vscode.DocumentSymbol[], depth: number): void {
		for (const sym of syms) {
			const text = doc.getText(sym.range);
			const startLine = sym.range.start.line;
			const endLine = sym.range.end.line;

			if (text.length > MAX_CHARS && sym.children.length > 0 && depth < 3) {
				// Container too large — recurse into its children instead.
				visit(sym.children, depth + 1);
			} else if (text.length >= MIN_CHARS) {
				const trimmed = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
				chunks.push(makeChunk(trimmed, startLine, endLine, relPath, sym.name));
			}
		}
	}

	visit(symbols, 0);
	return chunks;
}

// ---- Line-based fallback --------------------------------------------------------
function chunksFromLines(doc: vscode.TextDocument, relPath: string): RawChunk[] {
	const chunks: RawChunk[] = [];
	const total = doc.lineCount;

	for (let start = 0; start < total; start += LINES_PER_CHUNK - OVERLAP_LINES) {
		const end = Math.min(start + LINES_PER_CHUNK - 1, total - 1);
		const range = new vscode.Range(start, 0, end, doc.lineAt(end).text.length);
		const text = doc.getText(range);
		if (text.trim().length >= MIN_CHARS) {
			chunks.push(makeChunk(text, start, end, relPath, undefined));
		}
		if (end >= total - 1) { break; }
	}

	return chunks;
}

// ---- Helpers --------------------------------------------------------------------
function makeChunk(
	text: string,
	startLine: number,
	endLine: number,
	relPath: string,
	symbolName: string | undefined,
): RawChunk {
	return {
		file: relPath,
		range: { start: startLine, end: endLine },
		// Rough token estimate: ~4 chars / token for code.
		tokenCount: Math.ceil(text.length / 4),
		preview: text.slice(0, 150).replace(/\s+/g, ' ').trim(),
		symbolName,
		text,
	};
}
