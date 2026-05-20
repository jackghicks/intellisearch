import * as vscode from 'vscode';

// ---- Sizing constants -----------------------------------------------------------
//   jina-embeddings-v2-base-code sweet spot for retrieval is 128–256 tokens.
//   Single-threaded WASM inference time is roughly O(n²) in token count:
//     ~128 tokens (~512 chars)   ≈ 0.3–0.5 s
//     ~256 tokens (~1 024 chars) ≈ 0.8–1.2 s
//     ~512 tokens (~2 048 chars) ≈ 3–5 s      ← avoid
//
//   Hard cap: 1 024 chars ≈ 256 tokens.
//   Soft threshold: recurse into symbol children when symbol exceeds 800 chars.
//   Minimum meaningful chunk: 40 chars.
const MIN_CHARS = 40;
const SOFT_MAX_CHARS = 800;   // prefer to recurse into children above this
const MAX_CHARS = 1_024;       // hard ceiling — truncate anything beyond

// Line-based fallback: 15 lines per chunk with a 3-line overlap keeps chunks
// well within the 256-token target for typical code line lengths.
const LINES_PER_CHUNK = 15;
const OVERLAP_LINES = 3;

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

/** Auto-generated / lock files that are large and semantically useless to index. */
const EXCLUDED_FILENAMES = new Set([
	'package-lock.json',
	'npm-shrinkwrap.json',
	'yarn.lock',
	'pnpm-lock.yaml',
	'bun.lock',
	'composer.lock',
	'gemfile.lock',
	'cargo.lock',
	'poetry.lock',
	'pipfile.lock',
	'packages.lock.json',
]);

export function isIndexable(uri: vscode.Uri): boolean {
	const lower = uri.path.toLowerCase();
	const filename = lower.slice(lower.lastIndexOf('/') + 1);
	if (EXCLUDED_FILENAMES.has(filename)) { return false; }
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

			if (text.length > SOFT_MAX_CHARS && sym.children.length > 0 && depth < 4) {
				// Symbol is larger than our soft target — recurse into children first.
				visit(sym.children, depth + 1);
				// Also emit a truncated version of the parent so its signature /
				// docstring is represented in the index even for large containers.
				const header = text.slice(0, MAX_CHARS);
				if (header.length >= MIN_CHARS) {
					chunks.push(makeChunk(header, startLine, endLine, relPath, sym.name));
				}
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
