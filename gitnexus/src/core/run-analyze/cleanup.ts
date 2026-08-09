import fs from "node:fs/promises";
import { closeLbug } from "../lbug/lbug-adapter.js";

export async function removeLbugDatabaseFiles(lbugPath: string): Promise<void> {
	await closeLbug();
	const lbugFiles = [lbugPath, `${lbugPath}.wal`, `${lbugPath}.lock`];
	for (const f of lbugFiles) {
		try {
			await fs.rm(f, { recursive: true, force: true });
		} catch {
			/* swallow */
		}
	}
}
