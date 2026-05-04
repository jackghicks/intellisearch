import * as vscode from 'vscode';
import { IndexData } from './types';

const FOLDER = '.intellisearch';
const INDEX_FILE = 'index.json';
const VECTORS_FILE = 'vectors.bin';

function indexDir(workspaceUri: vscode.Uri): vscode.Uri {
	return vscode.Uri.joinPath(workspaceUri, FOLDER);
}

export async function saveIndex(
	workspaceUri: vscode.Uri,
	data: IndexData,
	vectors: Float32Array,
): Promise<void> {
	const dir = indexDir(workspaceUri);
	await vscode.workspace.fs.createDirectory(dir);

	const enc = new TextEncoder();
	await Promise.all([
		vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, INDEX_FILE),
			enc.encode(JSON.stringify(data)),
		),
		vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(dir, VECTORS_FILE),
			new Uint8Array(vectors.buffer),
		),
	]);
}

export async function loadIndex(
	workspaceUri: vscode.Uri,
): Promise<{ data: IndexData; vectors: Float32Array } | null> {
	try {
		const dir = indexDir(workspaceUri);
		const [indexBytes, vectorBytes] = await Promise.all([
			vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, INDEX_FILE)),
			vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, VECTORS_FILE)),
		]);

		const data: IndexData = JSON.parse(new TextDecoder().decode(indexBytes));

		// Copy into a fresh, correctly aligned buffer before wrapping in Float32Array.
		const aligned = new ArrayBuffer(vectorBytes.byteLength);
		new Uint8Array(aligned).set(vectorBytes);
		const vectors = new Float32Array(aligned);

		return { data, vectors };
	} catch {
		return null;
	}
}

export async function indexExists(workspaceUri: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(
			vscode.Uri.joinPath(workspaceUri, FOLDER, INDEX_FILE),
		);
		return true;
	} catch {
		return false;
	}
}
