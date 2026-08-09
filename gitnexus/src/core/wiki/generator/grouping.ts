import path from "node:path";
import type { FileWithExports } from "../graph-queries.js";
import type { ModuleTreeNode } from "./contracts.js";

export function parseGroupingResponse(
	content: string,
	files: FileWithExports[],
): Record<string, string[]> {
	// Extract JSON from response (handle markdown fences)
	let jsonStr = content.trim();
	const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
	if (fenceMatch) {
		jsonStr = fenceMatch[1].trim();
	}

	let parsed: Record<string, string[]>;
	try {
		parsed = JSON.parse(jsonStr);
	} catch {
		// Fallback: group by top-level directory
		return fallbackGrouping(files);
	}

	if (typeof parsed !== "object" || Array.isArray(parsed)) {
		return fallbackGrouping(files);
	}

	// Validate — ensure all files are assigned
	const allFilePaths = new Set(files.map((f) => f.filePath));
	const assignedFiles = new Set<string>();
	const validGrouping: Record<string, string[]> = {};

	for (const [mod, paths] of Object.entries(parsed)) {
		if (!Array.isArray(paths)) continue;
		const validPaths = paths.filter((p) => {
			if (allFilePaths.has(p) && !assignedFiles.has(p)) {
				assignedFiles.add(p);
				return true;
			}
			return false;
		});
		if (validPaths.length > 0) {
			validGrouping[mod] = validPaths;
		}
	}

	// Assign unassigned files to a "Miscellaneous" module
	const unassigned = files
		.map((f) => f.filePath)
		.filter((fp) => !assignedFiles.has(fp));
	if (unassigned.length > 0) {
		validGrouping.Other = unassigned;
	}

	return Object.keys(validGrouping).length > 0
		? validGrouping
		: fallbackGrouping(files);
}

export function fallbackGrouping(
	files: FileWithExports[],
): Record<string, string[]> {
	const groups = new Map<string, string[]>();
	for (const f of files) {
		const parts = f.filePath.replace(/\\/g, "/").split("/");
		const topDir = parts.length > 1 ? parts[0] : "Root";
		let group = groups.get(topDir);
		if (!group) {
			group = [];
			groups.set(topDir, group);
		}
		group.push(f.filePath);
	}
	return Object.fromEntries(groups);
}

export function splitBySubdirectory(
	moduleName: string,
	files: string[],
	slugify: (name: string) => string,
): ModuleTreeNode[] {
	const subGroups = new Map<string, string[]>();
	for (const fp of files) {
		const parts = fp.replace(/\\/g, "/").split("/");
		const subDir = parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0];
		let group = subGroups.get(subDir);
		if (!group) {
			group = [];
			subGroups.set(subDir, group);
		}
		group.push(fp);
	}

	// Check if basenames are unique; if not, use the full subDir path
	const basenames = Array.from(subGroups.keys()).map((s) => path.basename(s));
	const hasCollisions = new Set(basenames).size < basenames.length;

	return Array.from(subGroups.entries()).map(([subDir, subFiles]) => {
		const label = hasCollisions
			? subDir.replace(/\//g, "-")
			: path.basename(subDir);
		return {
			name: `${moduleName} — ${label}`,
			slug: slugify(`${moduleName}-${label}`),
			files: subFiles,
		};
	});
}
