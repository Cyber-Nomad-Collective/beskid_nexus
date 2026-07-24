import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildSpecLinkIndex,
	ensureSpecLinkIndex,
	loadSpecLinkIndex,
	resetSpecLinkIndexCache,
	searchSpecPages,
} from "../../src/server/nexus/spec-link-index.js";

describe("OpenSpec catalog link index", () => {
	let tempRoot: string;
	let catalogPath: string;
	let previousHome: string | undefined;

	const writeCatalog = async (revision: string, title = "MCP transport") => {
		await fs.writeFile(
			catalogPath,
			JSON.stringify({
				revision,
				entries: [
					{
						stableId: "standard.tooling.nexus.mcp",
						title,
						kind: "requirement",
						canonicalUrl: "/standard/tooling--nexus#mcp-transport",
						legacySlugs: ["platform-spec/tooling/nexus/contracts-and-edge-cases"],
						requirementAnchor: "MCP transport",
						normativeText:
							"Nexus shall expose a versioned transport endpoint with explicit authentication.",
						requirements: [
							{
								id: "BSP-REQ-MCP-AUTH",
								title: "Authenticated transport",
								anchor: "requirement-authenticated-transport",
								legacySlug: "/platform-spec/tooling/nexus/contracts-and-edge-cases/",
							},
						],
					},
					{
						stableId: "standard.tooling.nexus.code-docs",
						title: "Code documentation",
						canonicalUrl: "/standard/tooling--nexus#code-documentation",
						legacySlugs: ["platform-spec/tooling/nexus/design-model"],
					},
				],
			}),
			"utf-8",
		);
	};

	beforeEach(async () => {
		tempRoot = await fs.mkdtemp(
			path.join(os.tmpdir(), "gitnexus-openspec-index-"),
		);
		catalogPath = path.join(tempRoot, "catalog.json");
		previousHome = process.env.GITNEXUS_HOME;
		process.env.GITNEXUS_HOME = path.join(tempRoot, "home");
		await writeCatalog("revision-1");
	});

	afterEach(async () => {
		resetSpecLinkIndexCache();
		if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
		else process.env.GITNEXUS_HOME = previousHome;
		await fs.rm(tempRoot, { recursive: true, force: true });
	});

	it("indexes stable IDs, canonical hrefs, aliases, and catalog revision", async () => {
		const index = await buildSpecLinkIndex(catalogPath);
		expect(index).toMatchObject({
			version: 2,
			revision: "revision-1",
			catalogPath,
		});
		expect(
			index.pages.find(
				(page) => page.stableId === "standard.tooling.nexus.code-docs",
			),
		).toMatchObject({
			stableId: "standard.tooling.nexus.code-docs",
			href: "/standard/tooling--nexus#code-documentation",
		});
		expect(
			index.pages.find((page) => page.stableId === "BSP-REQ-MCP-AUTH"),
		).toMatchObject({
			stableId: "BSP-REQ-MCP-AUTH",
			href: "/standard/tooling--nexus#requirement-authenticated-transport",
		});
		expect(
			index.pages.find((page) => page.stableId === "standard.tooling.nexus.mcp"),
		).toMatchObject({
			stableId: "standard.tooling.nexus.mcp",
			aliases: ["platform-spec/tooling/nexus/contracts-and-edge-cases"],
		});
	});

	it("searches stable IDs and legacy aliases while returning typed revision metadata", async () => {
		const index = await buildSpecLinkIndex(catalogPath);
		const hits = searchSpecPages(index, "nexus mcp transport", 3);
		expect(hits[0]).toMatchObject({
			stableId: "standard.tooling.nexus.mcp",
			href: "/standard/tooling--nexus#mcp-transport",
			revision: "revision-1",
		});
	});

	it("invalidates memory and persisted caches when catalog content changes", async () => {
		const first = await ensureSpecLinkIndex(catalogPath);
		expect(first.revision).toBe("revision-1");

		await writeCatalog("revision-2", "Authenticated MCP transport");
		const second = await ensureSpecLinkIndex(catalogPath);
		expect(second.revision).toBe("revision-2");
		expect(second.sourceHash).not.toBe(first.sourceHash);
		expect(
			second.pages.find((page) => page.stableId === "standard.tooling.nexus.mcp")
				?.title,
		).toBe("Authenticated MCP transport");

		resetSpecLinkIndexCache();
		expect((await loadSpecLinkIndex())?.revision).toBe("revision-2");
	});
});
