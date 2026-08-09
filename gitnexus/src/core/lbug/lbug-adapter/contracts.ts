// ---------------------------------------------------------------------------
// Relationship CSV splitting — extracted for testability (PR #818)
// ---------------------------------------------------------------------------

/** Factory for creating WriteStreams — injectable for testing. */
export type WriteStreamFactory = (filePath: string) => import("fs").WriteStream;

/** Result of splitting the relationship CSV into per-label-pair files. */
export interface RelCsvSplitResult {
	relHeader: string;
	relsByPairMeta: Map<string, { csvPath: string; rows: number }>;
	pairWriteStreams: Map<string, import("fs").WriteStream>;
	skippedRels: number;
	totalValidRels: number;
}

