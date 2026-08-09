import type { FileHashDiff } from "../../storage/file-hash.js";
import type { RepoMeta } from "../../storage/repo-manager.js";
import type { PipelineResult } from "../../types/pipeline.js";
import { shadowCandidatesFor } from "../incremental/shadow-candidates.js";
import {
	computeEffectiveWriteSet,
	extractChangedSubgraph,
} from "../incremental/subgraph-extract.js";
import {
	deleteAllCommunitiesAndProcesses,
	deleteNodesForFile,
	loadGraphToLbug,
	queryImporters,
} from "../lbug/lbug-adapter.js";

interface LoadPipelineGraphOptions {
	isIncremental: boolean;
	hashDiff: FileHashDiff | undefined;
	pipelineResult: PipelineResult;
	existingMeta: RepoMeta | null;
	storagePath: string;
	log: (message: string) => void;
	progress: (phase: string, percent: number, message: string) => void;
}

export async function loadPipelineGraph({
	isIncremental,
	hashDiff,
	pipelineResult,
	existingMeta,
	storagePath,
	log,
	progress,
}: LoadPipelineGraphOptions): Promise<void> {
	let lbugMsgCount = 0;
	if (isIncremental && hashDiff) {
		// ── Incremental DB writeback ───────────────────────────────────
		// 0. Expand the writable set with transitive importers of
		//    changed/deleted files (bounded BFS).
		//
		//    Reason (Bugbot/Claude review on PR #1479): when a barrel /
		//    re-export file C changes, cross-file resolution may update
		//    CALLS edges between two unchanged files A and B (A imports
		//    from C, C re-exports something from B). Those refined edges
		//    live in `ctx.graph` but would be excluded from the subgraph
		//    if neither endpoint is in the changed set. To catch this,
		//    files that imported (directly OR transitively, through
		//    other unchanged intermediaries) any changed file get pulled
		//    into the writable set so their rows are deleted + rewritten
		//    against the refined edges.
		//
		//    BFS bound: MAX_IMPORTER_BFS_DEPTH. Practically sized to
		//    catch nested barrel chains (e.g. `index.ts → submodule/index.ts
		//    → submodule/impl.ts`) without ballooning into a near-full-
		//    rebuild on monorepos with deep re-export pyramids. Beyond
		//    this depth, the "incremental ≡ full-rebuild" invariant is
		//    self-acknowledged as best-effort; `--force` remains the
		//    escape hatch documented in GUARDRAILS.md.
		//
		//    `queryImporters` reads `IMPORTS` from the pre-pipeline DB
		//    state, so the result is "files that USED TO import the
		//    target" — exactly the set whose previously-stored edges may
		//    no longer match what cross-file resolution produces this run.
		const MAX_IMPORTER_BFS_DEPTH = 4;
		const writableFiles = new Set<string>(hashDiff.toWrite);
		const directlyChangedCount = writableFiles.size;

		// Shadow-seed: for ADDED files, queryImporters returns 0 (the new
		// file has no IMPORTS rows in the pre-pipeline DB yet). But pre-
		// existing unchanged files may have IMPORTS edges whose module-
		// resolution claim the newcomer can steal under standard JS/TS
		// resolution (Bugbot review on PR #1479). For each added file we
		// derive the shadow candidates and, if the candidate was a known
		// file in the prior meta, seed it into the BFS frontier so its
		// importers — surfaced via queryImporters — get their CALLS edges
		// re-resolved against the new file. See shadow-candidates.ts for
		// the full pattern catalogue.
		const priorFileSet = new Set<string>(
			existingMeta?.fileHashes ? Object.keys(existingMeta.fileHashes) : [],
		);
		const shadowSeed: string[] = [];
		for (const added of hashDiff.added) {
			for (const cand of shadowCandidatesFor(added)) {
				if (priorFileSet.has(cand) && !writableFiles.has(cand)) {
					shadowSeed.push(cand);
				}
			}
		}

		{
			let frontier: string[] = [
				...hashDiff.toWrite,
				...hashDiff.deleted,
				...shadowSeed,
			];
			for (
				let depth = 0;
				depth < MAX_IMPORTER_BFS_DEPTH && frontier.length > 0;
				depth++
			) {
				const nextFrontier: string[] = [];
				for (const f of frontier) {
					try {
						const importers = await queryImporters(f);
						for (const i of importers) {
							if (!writableFiles.has(i)) {
								writableFiles.add(i);
								nextFrontier.push(i);
							}
						}
					} catch {
						/* per-file importer query failure → skip; correctness degrades on
                 that branch, but DB stays writable. */
					}
				}
				frontier = nextFrontier;
			}
		}
		const importerExpansion = writableFiles.size - directlyChangedCount;
		if (importerExpansion > 0) {
			log(
				`Incremental: +${importerExpansion} importer(s) added to writable set ` +
					`(BFS depth ≤ ${MAX_IMPORTER_BFS_DEPTH}` +
					(shadowSeed.length > 0 ? `, ${shadowSeed.length} shadow-seed(s)` : "") +
					`)`,
			);
		}

		// 1. Compute the EFFECTIVE write-set (Finding 1). Two layers,
		//    composed:
		//      (a) `writableFiles` — toWrite ∪ transitive importers of
		//          changed/deleted files (the bounded BFS above, reading
		//          IMPORTS from the pre-pipeline DB).
		//      (b) `computeEffectiveWriteSet` — walks the NEW graph's
		//          edges and pulls in any unchanged-side file that sits
		//          on a writable-boundary-crossing edge (catches refined
		//          cross-file CALLS edges that the pre-run DB couldn't
		//          predict, e.g. a barrel re-export shifting `foo` from
		//          B to D).
		//    The composed set is the input to BOTH deleteNodesForFile
		//    and extractChangedSubgraph — asymmetry between the two would
		//    leave stale rows or PK-conflict at COPY time.
		const effectiveWriteSet = computeEffectiveWriteSet(
			pipelineResult.graph,
			writableFiles,
		);
		// Deduped: deleted entries may already appear via importer-BFS
		// expansion (queryImporters can return a now-deleted path), which
		// would otherwise call deleteNodesForFile twice for the same file
		// (Bugbot LOW finding on PR #1479).
		const filesToDelete = [
			...new Set([...effectiveWriteSet, ...hashDiff.deleted]),
		];
		for (let i = 0; i < filesToDelete.length; i++) {
			const f = filesToDelete[i];
			try {
				await deleteNodesForFile(f);
			} catch {
				/* file may not have rows (e.g. an unparseable file) — fine */
			}
			if (i % 20 === 0) {
				progress(
					"lbug",
					62,
					`Removing rows for changed files (${i}/${filesToDelete.length})...`,
				);
			}
		}
		// 2. Drop graph-wide nodes (Community, Process). They'll be re-inserted
		//    from the fresh pipeline output below. Required for the
		//    "Leiden runs on the FULL graph" correctness invariant.
		await deleteAllCommunitiesAndProcesses();

		// 3. Extract the changed subgraph from the FULL ctx.graph and write
		//    only that. Unchanged-file rows in the DB stay untouched. Pass
		//    the SAME effectiveWriteSet so the subgraph and the deletes
		//    cover identical files (asymmetry would silently corrupt).
		const subgraph = extractChangedSubgraph(
			pipelineResult.graph,
			effectiveWriteSet,
		);
		await loadGraphToLbug(
			subgraph,
			pipelineResult.repoPath,
			storagePath,
			(msg) => {
				lbugMsgCount++;
				const pct = Math.min(
					84,
					65 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 19),
				);
				progress("lbug", pct, msg);
			},
		);
	} else {
		// ── Full rebuild ───────────────────────────────────────────────
		await loadGraphToLbug(
			pipelineResult.graph,
			pipelineResult.repoPath,
			storagePath,
			(msg) => {
				lbugMsgCount++;
				const pct = Math.min(
					84,
					60 + Math.round((lbugMsgCount / (lbugMsgCount + 10)) * 24),
				);
				progress("lbug", pct, msg);
			},
		);
	}
}
