import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
export const MODEL_NAME = 'jinaai/jina-embeddings-v2-base-code';
export const VECTOR_DIM = 768;

export const ALWAYS_EXCLUDE = '**/.intellisearch/**';

/**
 * Builds a glob pattern that combines VS Code's files.exclude + search.exclude
 * settings (the same sources used by Find in Files' "Use Exclude Settings")
 * together with our own .intellisearch exclusion.
 */
export function buildExcludeGlob(): string {
	const filesExclude = vscode.workspace.getConfiguration('files').get<Record<string, boolean>>('exclude') ?? {};
	const searchExclude = vscode.workspace.getConfiguration('search').get<Record<string, boolean>>('exclude') ?? {};
	const patterns = [
		ALWAYS_EXCLUDE,
		...Object.entries({ ...filesExclude, ...searchExclude })
			.filter(([, enabled]) => enabled)
			.map(([pattern]) => pattern),
	];
	return patterns.length === 1 ? patterns[0] : `{${patterns.join(',')}}`;
}

// ---------------------------------------------------------------------------
// Gitignore-aware file filter
// ---------------------------------------------------------------------------

/**
 * Reads every .gitignore in the workspace (at any directory depth) and returns
 * a predicate that returns `true` when a URI should be treated as git-ignored.
 *
 * Handles the common subset of gitignore syntax:
 *  - `#` comments and blank lines
 *  - `!` negation
 *  - trailing `/`  (directory patterns — files inside are still ignored)
 *  - leading `/`   (anchor to the .gitignore's directory)
 *  - `*`  (any non-path-separator chars)
 *  - `**` (any chars including path separators)
 *  - `?`  (any single non-path-separator char)
 *  - patterns with an internal `/` are anchored; those without match at any depth
 */
export async function buildGitignoreFilter(
	workspaceUri: vscode.Uri,
): Promise<(uri: vscode.Uri) => boolean> {
	const rootPath = workspaceUri.path;

	// Pass null as the exclude so we pick up .gitignore files that might
	// themselves live inside folders excluded by workspace settings.
	const gitignoreUris = await vscode.workspace.findFiles(
		new vscode.RelativePattern(workspaceUri, '**/.gitignore'),
		null,
	);

	interface Rule { regex: RegExp; negated: boolean; }
	const rules: Rule[] = [];

	for (const giUri of gitignoreUris) {
		const giDir = giUri.path.slice(0, giUri.path.lastIndexOf('/'));
		// Workspace-relative base for this .gitignore (empty string = repo root)
		const relBase = giDir.length > rootPath.length
			? giDir.slice(rootPath.length + 1)
			: '';

		let content: string;
		try {
			content = new TextDecoder().decode(
				await vscode.workspace.fs.readFile(giUri),
			);
		} catch {
			continue;
		}

		for (const rawLine of content.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith('#')) { continue; }

			const negated = line.startsWith('!');
			let pat = negated ? line.slice(1).trim() : line;

			// Trailing slash = directory pattern; strip it — files inside still match.
			if (pat.endsWith('/')) { pat = pat.slice(0, -1); }

			const leadingSlash = pat.startsWith('/');
			if (leadingSlash) { pat = pat.slice(1); }

			// A pattern containing '/' (after removing leading slash) is relative
			// to the .gitignore directory. Otherwise it matches at any depth.
			const hasInternalSlash = pat.includes('/');

			// Convert gitignore glob to regex.
			// Step order matters: escape metacharacters first (excluding * and ?),
			// then replace ** (via placeholder) and * and ?.
			let p = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&'); // escape
			p = p.replace(/\*\*/g, '\x00');      // protect **
			p = p.replace(/\*/g, '[^/]*');        // * → non-separator run
			p = p.replace(/\?/g, '[^/]');         // ? → single non-separator
			p = p.replace(/\x00/g, '.*');         // ** → anything

			const escapedBase = relBase.replace(/[.+^${}()|[\]\\]/g, '\\$&');
			const basePrefix = escapedBase ? escapedBase + '/' : '';

			const regexStr = (leadingSlash || hasInternalSlash)
				? `^${basePrefix}${p}(/.*)?$`           // anchored to .gitignore dir
				: `^${basePrefix}(.*\/)?${p}(/.*)?$`;  // any depth under .gitignore dir

			try {
				rules.push({ regex: new RegExp(regexStr), negated });
			} catch {
				// Malformed regex — skip this pattern.
			}
		}
	}

	if (rules.length === 0) {
		return () => false;
	}

	return (uri: vscode.Uri): boolean => {
		const relPath = uri.path.startsWith(rootPath + '/')
			? uri.path.slice(rootPath.length + 1)
			: uri.path;

		let ignored = false;
		for (const { regex, negated } of rules) {
			if (regex.test(relPath)) { ignored = !negated; }
		}
		return ignored;
	};
}

// ---------------------------------------------------------------------------
// Float32 ↔ Base64  (btoa / atob are available in the web-worker host)
// ---------------------------------------------------------------------------
export function float32ToBase64(arr: Float32Array): string {
	const bytes = new Uint8Array(arr.buffer);
	const CHUNK = 0x8000; // 32 768 — safe upper bound for spread
	let binary = '';
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + CHUNK)));
	}
	return btoa(binary);
}

export function base64ToFloat32(b64: string): Float32Array {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	const aligned = new ArrayBuffer(bytes.byteLength);
	new Uint8Array(aligned).set(bytes);
	return new Float32Array(aligned);
}
