import fs from "node:fs/promises";
import path from "node:path";
import { getGlobalDir } from "../../storage/repo-manager.js";
import type { NexusConfigFile } from "./types.js";

const CONFIG_FILE = "nexus-config.json";

export const getNexusConfigPath = (): string =>
	path.join(getGlobalDir(), CONFIG_FILE);

export const loadNexusConfigFile =
	async (): Promise<NexusConfigFile | null> => {
		try {
			const raw = await fs.readFile(getNexusConfigPath(), "utf-8");
			return JSON.parse(raw) as NexusConfigFile;
		} catch {
			return null;
		}
	};

export const saveNexusConfigFile = async (
	config: NexusConfigFile,
): Promise<void> => {
	const dir = getGlobalDir();
	await fs.mkdir(dir, { recursive: true });
	await fs.writeFile(getNexusConfigPath(), JSON.stringify(config, null, 2), {
		mode: 0o600,
	});
};
