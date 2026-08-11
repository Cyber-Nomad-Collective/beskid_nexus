import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
	BESKID_CATALOG_SEEDS,
	ensureBeskidCatalogEntries,
	listCatalogEntries,
	type NexusCatalogEntry,
	normalizeGitRepoUrl,
	resolveCatalogRegistryEntry,
} from "../../src/server/nexus/catalog-store.js";
import type { RegistryEntry } from "../../src/storage/repo-manager.js";

const catalogEntry = (
	overrides: Partial<NexusCatalogEntry> = {},
): NexusCatalogEntry => ({
	id: "beskid-lang",
	displayName: "Beskid",
	description: "",
	gitUrl: "https://github.com/cyber-nomad-collective/beskid",
	enabled: true,
	sortOrder: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	...overrides,
});

const registryEntry = (
	overrides: Partial<RegistryEntry> = {},
): RegistryEntry => ({
	name: "beskid",
	path: "/data/repos/beskid",
	storagePath: "/data/repos/beskid/.gitnexus",
	indexedAt: "2026-01-01T00:00:00.000Z",
	lastCommit: "abc123",
	remoteUrl: "https://github.com/cyber-nomad-collective/beskid.git",
	...overrides,
});

describe("resolveCatalogRegistryEntry", () => {
	it("matches by registry name/id first", () => {
		const reg = resolveCatalogRegistryEntry(
			catalogEntry({ registryName: "beskid" }),
			[registryEntry()],
		);
		expect(reg?.name).toBe("beskid");
	});

	it("matches by normalized git URL when catalog id differs from registry name", () => {
		const reg = resolveCatalogRegistryEntry(catalogEntry(), [registryEntry()]);
		expect(reg?.name).toBe("beskid");
	});

	it("matches by git URL basename", () => {
		const reg = resolveCatalogRegistryEntry(catalogEntry(), [
			registryEntry({ remoteUrl: undefined, name: "beskid" }),
		]);
		expect(reg?.name).toBe("beskid");
	});
});

describe("normalizeGitRepoUrl", () => {
	it("normalizes github URLs consistently", () => {
		expect(normalizeGitRepoUrl("https://github.com/org/Repo.git")).toBe(
			"https://github.com/org/repo",
		);
	});
});

describe("ensureBeskidCatalogEntries", () => {
	it("seeds Corelib and Runtime once without duplicating existing entries", async () => {
		const previousHome = process.env.GITNEXUS_HOME;
		const previousSeedFlag = process.env.NEXUS_SEED_BESKID_REPOS;
		const home = await mkdtemp(path.join(os.tmpdir(), "gitnexus-catalog-"));
		process.env.GITNEXUS_HOME = home;
		delete process.env.NEXUS_SEED_BESKID_REPOS;

		try {
			const first = await ensureBeskidCatalogEntries();
			const second = await ensureBeskidCatalogEntries();
			const seeded = second.filter((entry) =>
				BESKID_CATALOG_SEEDS.some((seed) => seed.id === entry.id),
			);

			expect(first.map((entry) => entry.id)).toEqual([
				"beskid-corelib",
				"beskid-runtime",
			]);
			expect(second).toEqual(first);
			expect(seeded).toHaveLength(2);
			expect((await listCatalogEntries())).toHaveLength(2);
		} finally {
			if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
			else process.env.GITNEXUS_HOME = previousHome;
			if (previousSeedFlag === undefined)
				delete process.env.NEXUS_SEED_BESKID_REPOS;
			else process.env.NEXUS_SEED_BESKID_REPOS = previousSeedFlag;
			await rm(home, { recursive: true, force: true });
		}
	});

	it("supports disabling the Beskid bootstrap", async () => {
		const previousHome = process.env.GITNEXUS_HOME;
		const previousSeedFlag = process.env.NEXUS_SEED_BESKID_REPOS;
		const home = await mkdtemp(path.join(os.tmpdir(), "gitnexus-catalog-"));
		process.env.GITNEXUS_HOME = home;
		process.env.NEXUS_SEED_BESKID_REPOS = "0";

		try {
			expect(await ensureBeskidCatalogEntries()).toEqual([]);
		} finally {
			if (previousHome === undefined) delete process.env.GITNEXUS_HOME;
			else process.env.GITNEXUS_HOME = previousHome;
			if (previousSeedFlag === undefined)
				delete process.env.NEXUS_SEED_BESKID_REPOS;
			else process.env.NEXUS_SEED_BESKID_REPOS = previousSeedFlag;
			await rm(home, { recursive: true, force: true });
		}
	});
});
