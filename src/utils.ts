// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------
export const MODEL_NAME = 'jinaai/jina-embeddings-v2-base-code';
export const VECTOR_DIM = 768;

// Passing `undefined` as the exclude argument to findFiles makes VS Code merge
// files.exclude + search.exclude settings AND honour .gitignore files
// (controlled by the search.useIgnoreFiles setting, which is on by default).
// We only hard-exclude .intellisearch/ ourselves — everything else is left to
// VS Code / gitignore so that user configuration is respected.
export const ALWAYS_EXCLUDE = '**/.intellisearch/**';

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
