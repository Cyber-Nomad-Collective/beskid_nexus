import { SymbolsBackend } from "./symbols.js";
import { type RepoHandle, logQueryError } from "./formatting-errors.js";
import fs from "node:fs/promises";
import path from "node:path";
import { executeParameterized } from "../../../core/lbug/pool-adapter.js";
import { type FileDiff, parseDiffHunks } from "../../../storage/git.js";

export class ChangesBackend extends SymbolsBackend {
	protected async detectChanges(
		repo: RepoHandle,
		params: {
			scope?: string;
			base_ref?: string;
		},
	): Promise<any> {
		await this.ensureInitialized(repo.id);

		const scope = params.scope || "unstaged";
		const { execFileSync } = await import("node:child_process");

		// Build git diff args based on scope (using execFileSync to avoid shell injection)
		let diffArgs: string[];
		switch (scope) {
			case "staged":
				diffArgs = ["diff", "--staged", "-U0"];
				break;
			case "all":
				diffArgs = ["diff", "HEAD", "-U0"];
				break;
			case "compare":
				if (!params.base_ref)
					return { error: 'base_ref is required for "compare" scope' };
				diffArgs = ["diff", params.base_ref, "-U0"];
				break;
			default:
				diffArgs = ["diff", "-U0"];
				break;
		}

		let diffOutput: string;
		try {
			// maxBuffer raised from Node's 1MB default to 256MB to avoid ENOBUFS on
			// repos with large unstaged/untracked diffs (e.g. unignored build folders).
			// See issue: spawnSync git ENOBUFS in detect_changes(scope="unstaged").
			diffOutput = execFileSync("git", diffArgs, {
				cwd: repo.repoPath,
				encoding: "utf-8",
				maxBuffer: 256 * 1024 * 1024,
			});
		} catch (err: any) {
			return { error: `Git diff failed: ${err.message}` };
		}

		const fileDiffs: FileDiff[] = parseDiffHunks(diffOutput);

		if (fileDiffs.length === 0) {
			return {
				summary: {
					changed_count: 0,
					affected_count: 0,
					risk_level: "none",
					message: "No changes detected.",
				},
				changed_symbols: [],
				affected_processes: [],
			};
		}

		// Map diff hunks to indexed symbols via range overlap
		const changedSymbols: any[] = [];
		for (const fileDiff of fileDiffs) {
			if (fileDiff.hunks.length === 0) continue;

			// Build range overlap conditions for all hunks in this file
			const overlapConditions = fileDiff.hunks
				.map(
					(_, i) => `(n.startLine <= $hunkEnd${i} AND n.endLine >= $hunkStart${i})`,
				)
				.join(" OR ");

			const queryParams: Record<string, any> = { filePath: fileDiff.filePath };
			fileDiff.hunks.forEach((hunk, i) => {
				queryParams[`hunkStart${i}`] = hunk.startLine;
				queryParams[`hunkEnd${i}`] = hunk.endLine;
			});

			const symbolQuery = `
        MATCH (n) WHERE n.filePath ENDS WITH $filePath
          AND n.startLine IS NOT NULL AND n.endLine IS NOT NULL
          AND (${overlapConditions})
        RETURN n.id AS id, n.name AS name, labels(n)[0] AS type,
               n.filePath AS filePath, n.startLine AS startLine, n.endLine AS endLine
      `;

			try {
				const rows = await executeParameterized(repo.id, symbolQuery, queryParams);
				for (const sym of rows) {
					changedSymbols.push({
						id: sym.id || sym[0],
						name: sym.name || sym[1],
						type: sym.type || sym[2],
						filePath: sym.filePath || sym[3],
						change_type: "touched",
					});
				}
			} catch (e) {
				logQueryError("detect-changes:file-symbols", e);
			}
		}

		// Find affected processes -- single batched query instead of N+1
		const affectedProcesses = new Map<string, any>();
		if (changedSymbols.length > 0) {
			const symIds = changedSymbols.map((s) => s.id);
			const symNameById = new Map(changedSymbols.map((s) => [s.id, s.name]));
			try {
				const procs = await executeParameterized(
					repo.id,
					`
          MATCH (n)-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          WHERE n.id IN $ids
          RETURN n.id AS nodeId, p.id AS pid, p.heuristicLabel AS label,
                 p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
					{ ids: symIds },
				);
				for (const proc of procs) {
					const nodeId = proc.nodeId || proc[0];
					const pid = proc.pid || proc[1];
					if (!affectedProcesses.has(pid)) {
						affectedProcesses.set(pid, {
							id: pid,
							name: proc.label || proc[2],
							process_type: proc.processType || proc[3],
							step_count: proc.stepCount || proc[4],
							changed_steps: [],
						});
					}
					affectedProcesses.get(pid)?.changed_steps.push({
						symbol: symNameById.get(nodeId) ?? nodeId,
						step: proc.step || proc[5],
					});
				}
			} catch (e) {
				logQueryError("detect-changes:process-lookup", e);
			}
		}

		const processCount = affectedProcesses.size;
		const risk =
			processCount === 0
				? "low"
				: processCount <= 5
					? "medium"
					: processCount <= 15
						? "high"
						: "critical";

		return {
			summary: {
				changed_count: changedSymbols.length,
				affected_count: processCount,
				changed_files: fileDiffs.length,
				risk_level: risk,
			},
			changed_symbols: changedSymbols,
			affected_processes: Array.from(affectedProcesses.values()),
		};
	}

	/**
	 * Rename tool — multi-file coordinated rename using graph + text search.
	 * Graph refs are tagged "graph" (high confidence).
	 * Additional refs found via text search are tagged "text_search" (lower confidence).
	 */
	protected async rename(
		repo: RepoHandle,
		params: {
			symbol_name?: string;
			symbol_uid?: string;
			new_name: string;
			file_path?: string;
			dry_run?: boolean;
		},
	): Promise<any> {
		await this.ensureInitialized(repo.id);

		const { new_name, file_path } = params;
		const dry_run = params.dry_run ?? true;

		if (!params.symbol_name && !params.symbol_uid) {
			return { error: "Either symbol_name or symbol_uid is required." };
		}

		/** Guard: ensure a file path resolves within the repo root (prevents path traversal) */
		const assertSafePath = (filePath: string): string => {
			const full = path.resolve(repo.repoPath, filePath);
			if (!full.startsWith(repo.repoPath + path.sep) && full !== repo.repoPath) {
				throw new Error(`Path traversal blocked: ${filePath}`);
			}
			return full;
		};

		// Step 1: Find the target symbol (reuse context's lookup)
		const lookupResult = await this.context(repo, {
			name: params.symbol_name,
			uid: params.symbol_uid,
			file_path,
		});

		if (lookupResult.status === "ambiguous") {
			return lookupResult; // pass disambiguation through
		}
		if (lookupResult.error) {
			return lookupResult;
		}

		const sym = lookupResult.symbol;
		const oldName = sym.name;

		if (oldName === new_name) {
			return { error: "New name is the same as the current name." };
		}

		// Step 2: Collect edits from graph (high confidence)
		const changes = new Map<string, { file_path: string; edits: any[] }>();

		const addEdit = (
			filePath: string,
			line: number,
			oldText: string,
			newText: string,
			confidence: string,
		) => {
			if (!changes.has(filePath)) {
				changes.set(filePath, { file_path: filePath, edits: [] });
			}
			changes
				.get(filePath)
				?.edits.push({ line, old_text: oldText, new_text: newText, confidence });
		};

		// The definition itself
		if (sym.filePath && sym.startLine) {
			try {
				const content = await fs.readFile(assertSafePath(sym.filePath), "utf-8");
				const lines = content.split("\n");
				const lineIdx = sym.startLine - 1;
				if (
					lineIdx >= 0 &&
					lineIdx < lines.length &&
					lines[lineIdx].includes(oldName)
				) {
					const defRegex = new RegExp(
						`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
						"g",
					);
					addEdit(
						sym.filePath,
						sym.startLine,
						lines[lineIdx].trim(),
						lines[lineIdx].replace(defRegex, new_name).trim(),
						"graph",
					);
				}
			} catch (e) {
				logQueryError("rename:read-definition", e);
			}
		}

		// All incoming refs from graph (callers, importers, etc.)
		const allIncoming = [
			...(lookupResult.incoming.calls || []),
			...(lookupResult.incoming.imports || []),
			...(lookupResult.incoming.extends || []),
			...(lookupResult.incoming.implements || []),
		];

		let graphEdits = changes.size > 0 ? 1 : 0; // count definition edit

		for (const ref of allIncoming) {
			if (!ref.filePath) continue;
			try {
				const content = await fs.readFile(assertSafePath(ref.filePath), "utf-8");
				const lines = content.split("\n");
				for (let i = 0; i < lines.length; i++) {
					if (lines[i].includes(oldName)) {
						addEdit(
							ref.filePath,
							i + 1,
							lines[i].trim(),
							lines[i]
								.replace(
									new RegExp(
										`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
										"g",
									),
									new_name,
								)
								.trim(),
							"graph",
						);
						graphEdits++;
						break; // one edit per file from graph refs
					}
				}
			} catch (e) {
				logQueryError("rename:read-ref", e);
			}
		}

		// Step 3: Text search for refs the graph might have missed
		let astSearchEdits = 0;
		const graphFiles = new Set(
			[sym.filePath, ...allIncoming.map((r) => r.filePath)].filter(Boolean),
		);

		// Simple text search across the repo for the old name (in files not already covered by graph)
		try {
			const { execFileSync } = await import("node:child_process");
			const rgArgs = [
				"-l",
				"--type-add",
				"code:*.{ts,tsx,js,jsx,py,go,rs,java,c,h,cpp,cc,cxx,hpp,hxx,hh,cs,php,swift}",
				"-t",
				"code",
				`\\b${oldName}\\b`,
				".",
			];
			const output = execFileSync("rg", rgArgs, {
				cwd: repo.repoPath,
				encoding: "utf-8",
				timeout: 5000,
				// Avoid ENOBUFS on large repos: rg -l can list many files.
				maxBuffer: 256 * 1024 * 1024,
			});
			const files = output
				.trim()
				.split("\n")
				.filter((f) => f.length > 0);

			for (const file of files) {
				const normalizedFile = file.replace(/\\/g, "/").replace(/^\.\//, "");
				if (graphFiles.has(normalizedFile)) continue; // already covered by graph

				try {
					const content = await fs.readFile(assertSafePath(normalizedFile), "utf-8");
					const lines = content.split("\n");
					const regex = new RegExp(
						`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
						"g",
					);
					for (let i = 0; i < lines.length; i++) {
						regex.lastIndex = 0;
						if (regex.test(lines[i])) {
							regex.lastIndex = 0;
							addEdit(
								normalizedFile,
								i + 1,
								lines[i].trim(),
								lines[i].replace(regex, new_name).trim(),
								"text_search",
							);
							astSearchEdits++;
						}
					}
				} catch (e) {
					logQueryError("rename:text-search-read", e);
				}
			}
		} catch (e) {
			logQueryError("rename:ripgrep", e);
		}

		// Step 4: Apply or preview
		const allChanges = Array.from(changes.values());
		const totalEdits = allChanges.reduce((sum, c) => sum + c.edits.length, 0);

		if (!dry_run) {
			// Apply edits to files
			for (const change of allChanges) {
				try {
					const fullPath = assertSafePath(change.file_path);
					let content = await fs.readFile(fullPath, "utf-8");
					const regex = new RegExp(
						`\\b${oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
						"g",
					);
					content = content.replace(regex, new_name);
					await fs.writeFile(fullPath, content, "utf-8");
				} catch (e) {
					logQueryError("rename:apply-edit", e);
				}
			}
		}

		return {
			status: "success",
			old_name: oldName,
			new_name,
			files_affected: allChanges.length,
			total_edits: totalEdits,
			graph_edits: graphEdits,
			text_search_edits: astSearchEdits,
			changes: allChanges,
			applied: !dry_run,
		};
	}

}
