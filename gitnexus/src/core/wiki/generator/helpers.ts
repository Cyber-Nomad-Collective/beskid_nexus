import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { estimateTokens } from "../llm-client.js";
import type { ModuleTreeNode } from "./contracts.js";

export function getCurrentCommit(repoPath: string): string {
	try {
		return execSync("git rev-parse HEAD", { cwd: repoPath }).toString().trim();
	} catch {
		return "";
	}
}

export function isCommitReachable(
	repoPath: string,
	fromCommit: string,
	toCommit: string,
): boolean {
	try {
		execFileSync("git", ["merge-base", "--is-ancestor", fromCommit, toCommit], {
			cwd: repoPath,
			stdio: "ignore",
		});
		return true;
	} catch {
		return false;
	}
}

export function getChangedFiles(
	repoPath: string,
	fromCommit: string,
	toCommit: string,
): string[] | null {
	// First check if fromCommit is reachable from toCommit
	// This handles the case where wiki was generated on a different branch
	if (!isCommitReachable(repoPath, fromCommit, toCommit)) {
		return null; // Signal that we can't compute diff (divergent branches)
	}

	try {
		const output = execFileSync(
			"git",
			["diff", `${fromCommit}..${toCommit}`, "--name-only"],
			{
				cwd: repoPath,
			},
		)
			.toString()
			.trim();
		return output ? output.split("\n").filter(Boolean) : [];
	} catch {
		return null; // Treat git errors as needing full regen
	}
}

export async function readSourceFiles(
	repoPath: string,
	filePaths: string[],
): Promise<string> {
	const parts: string[] = [];
	for (const fp of filePaths) {
		const fullPath = path.join(repoPath, fp);
		try {
			const content = await fs.readFile(fullPath, "utf-8");
			parts.push(`\n--- ${fp} ---\n${content}`);
		} catch {
			parts.push(`\n--- ${fp} ---\n(file not readable)`);
		}
	}
	return parts.join("\n");
}

export function truncateSource(source: string, maxTokens: number): string {
	// Rough truncation: keep first maxTokens*4 chars and add notice
	const maxChars = maxTokens * 4;
	if (source.length <= maxChars) return source;
	return (
		source.slice(0, maxChars) +
		"\n\n... (source truncated for context window limits)"
	);
}

export async function estimateModuleTokens(
	repoPath: string,
	filePaths: string[],
): Promise<number> {
	let total = 0;
	for (const fp of filePaths) {
		try {
			const content = await fs.readFile(path.join(repoPath, fp), "utf-8");
			total += estimateTokens(content);
		} catch {
			// File not readable, skip
		}
	}
	return total;
}

export async function readProjectInfo(repoPath: string): Promise<string> {
	const candidates = [
		"package.json",
		"Cargo.toml",
		"pyproject.toml",
		"go.mod",
		"pom.xml",
		"build.gradle",
	];
	const lines: string[] = [`Project: ${path.basename(repoPath)}`];

	for (const file of candidates) {
		const fullPath = path.join(repoPath, file);
		try {
			const content = await fs.readFile(fullPath, "utf-8");
			if (file === "package.json") {
				const pkg = JSON.parse(content);
				if (pkg.name) lines.push(`Name: ${pkg.name}`);
				if (pkg.description) lines.push(`Description: ${pkg.description}`);
				if (pkg.scripts)
					lines.push(`Scripts: ${Object.keys(pkg.scripts).join(", ")}`);
			} else {
				// Include first 500 chars of other config files
				lines.push(`\n${file}:\n${content.slice(0, 500)}`);
			}
			break; // Use first config found
		} catch {}
	}

	// Read README excerpt
	for (const readme of ["README.md", "readme.md", "README.txt"]) {
		try {
			const content = await fs.readFile(path.join(repoPath, readme), "utf-8");
			lines.push(`\nREADME excerpt:\n${content.slice(0, 1000)}`);
			break;
		} catch {}
	}

	return lines.join("\n");
}

export function extractModuleFiles(
	tree: ModuleTreeNode[],
): Record<string, string[]> {
	const result: Record<string, string[]> = {};
	for (const node of tree) {
		if (node.children && node.children.length > 0) {
			result[node.name] = node.children.flatMap((c) => c.files);
			for (const child of node.children) {
				result[child.name] = child.files;
			}
		} else {
			result[node.name] = node.files;
		}
	}
	return result;
}

export function countModules(tree: ModuleTreeNode[]): number {
	let count = 0;
	for (const node of tree) {
		count++;
		if (node.children) {
			count += node.children.length;
		}
	}
	return count;
}

export function flattenModuleTree(tree: ModuleTreeNode[]): {
	leaves: ModuleTreeNode[];
	parents: ModuleTreeNode[];
} {
	const leaves: ModuleTreeNode[] = [];
	const parents: ModuleTreeNode[] = [];

	for (const node of tree) {
		if (node.children && node.children.length > 0) {
			for (const child of node.children) {
				leaves.push(child);
			}
			parents.push(node);
		} else {
			leaves.push(node);
		}
	}

	return { leaves, parents };
}
