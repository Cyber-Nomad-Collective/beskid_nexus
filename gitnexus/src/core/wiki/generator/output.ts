import fs from "node:fs/promises";
import path from "node:path";
import type { ModuleTreeNode, WikiMeta } from "./contracts.js";

export async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath);
		return true;
	} catch {
		return false;
	}
}

export async function loadWikiMeta(wikiDir: string): Promise<WikiMeta | null> {
	try {
		const raw = await fs.readFile(path.join(wikiDir, "meta.json"), "utf-8");
		return JSON.parse(raw) as WikiMeta;
	} catch {
		return null;
	}
}

export async function saveWikiMeta(
	wikiDir: string,
	meta: WikiMeta,
): Promise<void> {
	await fs.writeFile(
		path.join(wikiDir, "meta.json"),
		JSON.stringify(meta, null, 2),
		"utf-8",
	);
}

export async function saveModuleTree(
	wikiDir: string,
	tree: ModuleTreeNode[],
): Promise<void> {
	await fs.writeFile(
		path.join(wikiDir, "module_tree.json"),
		JSON.stringify(tree, null, 2),
		"utf-8",
	);
}
