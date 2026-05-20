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
