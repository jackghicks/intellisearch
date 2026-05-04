export interface Chunk {
	id: number
	file: string
	range: { start: number; end: number }
	tokenCount: number
	/** Index of the first float in vectors.bin (each embedding occupies VECTOR_DIM floats) */
	vectorOffset: number
	/** First ~150 chars of the chunk text, whitespace-collapsed, for result display */
	preview: string
	/** Symbol name from the document symbol provider, if any */
	symbolName?: string
}

export interface FileMetadata {
	mtime: number
	chunkCount: number
}

export interface MetaJson {
	version: number
	model: string
	created: number
	chunkCount: number
	vectorDim: number
}

export interface IndexData {
	meta: MetaJson
	chunks: Chunk[]
	files: Record<string, FileMetadata>
}
